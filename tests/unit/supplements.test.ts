import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { configWithPrivateSupplements, validateConfig, validateSourceConfig } from '../../src/application/config.js';
import { generateFromHtml } from '../../src/application/generate.js';
import { errorCategory } from '../../src/application/log.js';
import { expandCourses } from '../../src/schedule/expand.js';
import { SupplementError } from '../../src/schedule/supplements.js';
import { cacheIdentity } from '../../src/entrypoints/worker.js';
import { config, course, timetable } from '../fixtures/timetable.js';
import { supplements } from '../fixtures/supplements.js';

const withSupplements = (value: unknown = supplements, base = config) => configWithPrivateSupplements(base, JSON.stringify(value));
const now = new Date('2026-09-24T00:00:00Z');
const manual = supplements.courses[0]!;
const slot = manual.slots[0]!;

describe('private course supplements', () => {
  it('overrides all upstream locations without changing identities, including blank locations', () => {
    const original = expandCourses([course], config);
    for (const input of [course, { ...course, segments: ['1~4周 每周周一1~2节', '1~4周 周三3~4节(单)'] }]) {
      const events = expandCourses([input], withSupplements({ ...supplements, courses: [] }));
      expect(events.map(e => e.uid)).toEqual(original.map(e => e.uid));
      expect(events.every(e => e.location === supplements.locations[0]!.location)).toBe(true);
    }
    const parsed = new ICAL.Component(ICAL.parse(generateFromHtml(timetable(), withSupplements(), now).ics));
    const events = parsed.getAllSubcomponents('vevent');
    expect(events).toHaveLength(8);
    expect(events.some(event => event.getFirstPropertyValue('location') === '手动教室，101')).toBe(true);
  });
  it('does not re-add missing courses through location overrides', () => {
    expect(expandCourses([], withSupplements({ ...supplements, courses: [] }))).toEqual([]);
  });
  it.each([['odd', ['2026-09-09', '2026-09-23']], ['even', ['2026-09-16', '2026-09-30']],
    ['all', ['2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']]])('uses teaching-week parity %s', (parity, dates) => {
    const value = { ...supplements, courses: [{ ...manual, slots: [{ ...slot, weeks: { ...slot.weeks, parity } }] }] };
    expect(expandCourses([], withSupplements(value)).map(e => e.originalDate)).toEqual(dates);
  });
  it('shares holidays, makeups, multiple slots and nonchronological period mapping', () => {
    const value = { ...supplements, courses: [{ ...manual, slots: [slot, { ...slot, weekday: 5 }] }] };
    const base = { ...config, holidays: ['2026-09-09', '2026-09-25'], makeups: { '2026-09-12': '2026-09-09' },
      periods: [{ period: 1, start: '14:00', end: '14:50' }, { period: 2, start: '13:00', end: '13:50' }] };
    const events = expandCourses([], withSupplements(value, base));
    expect(events).toHaveLength(3);
    const moved = events.find(e => e.originalDate === '2026-09-09')!;
    expect(moved.start).toBe('2026-09-12T05:00:00.000Z');
    expect(moved.end).toBe('2026-09-12T06:50:00.000Z');
    expect(events.map(e => e.originalDate)).not.toContain('2026-09-25');
  });
  it('keeps manual UIDs when upstream later supplies the same course and manual input is removed', () => {
    const before = expandCourses([], withSupplements());
    const after = expandCourses([{ courseId: manual.courseId, classId: manual.classId, name: '系统名称', teacher: '系统教师',
      segments: ['1~4周 单周 周三1~2节 系统教室'] }], config);
    expect(before.map(e => e.uid)).toEqual(after.map(e => e.uid));
    expect(expandCourses([], withSupplements({ ...supplements, courses: [{ ...manual, name: '新名称', location: '新教室' }] })).map(e => e.uid))
      .toEqual(before.map(e => e.uid));
  });
  it('rejects a manual identity already present upstream, even if it would be skipped', () => {
    const duplicated = { ...course, courseId: manual.courseId };
    expect(() => expandCourses([duplicated], withSupplements())).toThrow('supplements:conflict');
    expect(() => generateFromHtml(timetable([{ course: duplicated }]), withSupplements(), now)).toThrow('supplements:conflict');
  });
  it('rejects conflicts with unscheduled confirmations and location overrides', () => {
    const base = { ...config, unscheduledCourses: [{ semester: config.semester, courseId: manual.courseId, classId: manual.classId,
      confirmed: true as const, expectedSegments: ['(无固定时间)'] }] };
    expect(() => withSupplements(supplements, base)).toThrow('supplements:conflict');
    expect(() => withSupplements({ ...supplements, locations: [{ courseId: manual.courseId, classId: manual.classId, location: '教室' }] }))
      .toThrow('supplements:conflict');
  });
  it.each([
    { ...supplements, semester: '2025-2026-1' }, { ...supplements, extra: true }, [],
    { ...supplements, locations: [...supplements.locations, ...supplements.locations] },
    { ...supplements, locations: [{ ...supplements.locations[0], location: '' }] },
    { ...supplements, courses: [manual, manual] },
    { ...supplements, courses: [{ ...manual, name: '' }] },
    { ...supplements, courses: [{ ...manual, slots: [] }] },
    ...[
      { ...slot, weekday: 0 }, { ...slot, weekday: 8 }, { ...slot, startPeriod: 0 },
      { ...slot, endPeriod: 5 }, { ...slot, endPeriod: 1, startPeriod: 2 },
      { ...slot, weeks: { start: 2, end: 1, parity: 'all' } },
      { ...slot, weeks: { start: 1, end: 5, parity: 'all' } },
      { ...slot, weeks: { start: 2, end: 2, parity: 'odd' } },
      { ...slot, weeks: { start: 1, end: 2, parity: 'invalid' } },
    ].map(slot => ({ ...supplements, courses: [{ ...manual, slots: [slot] }] })),
  ])('rejects invalid supplements %# before generation', value => {
    expect(() => withSupplements(value)).toThrow('supplements:invalid');
  });
  it('rejects intersecting occurrences with the same original slot identity', () => {
    const value = { ...supplements, courses: [{ ...manual, slots: [slot, { ...slot, weeks: { start: 3, end: 3, parity: 'all' } }] }] };
    expect(() => withSupplements(value)).toThrow('supplements:duplicate');
  });
  it('permits different courses to overlap and defaults optional text to empty', () => {
    const { teacher: _teacher, location: _location, ...minimal } = manual;
    const value = { ...supplements, courses: [minimal, { ...minimal, courseId: 'SYN004' }] };
    const events = expandCourses([], withSupplements(value));
    expect(events).toHaveLength(4);
    expect(events.every(e => e.location === '')).toBe(true);
  });
  it('does not bypass an invalid upstream schedule', () => {
    expect(() => generateFromHtml('invalid', withSupplements(), now)).toThrow('parse:structure');
    expect(() => expandCourses([{ ...course, segments: ['无法解析'] }], withSupplements())).toThrow('schedule:time');
  });
  it('canonicalizes order without modifying input and isolates changed supplements', () => {
    const value = { ...supplements, locations: [...supplements.locations, { courseId: 'SYN005', classId: '01', location: '教室' }],
      courses: [{ ...manual, slots: [slot, { ...slot, weekday: 5 }] }, { ...manual, courseId: 'SYN004' }] };
    const before = JSON.stringify(value);
    const first = withSupplements(value);
    expect(JSON.stringify(value)).toBe(before);
    const reordered = withSupplements({ ...value, locations: [...value.locations].reverse(), courses: [...value.courses].reverse()
      .map(c => ({ ...c, slots: [...c.slots].reverse() })) });
    expect(cacheIdentity(first, 'synthetic')).toEqual(cacheIdentity(reordered, 'synthetic'));
    expect(cacheIdentity(first, 'synthetic')).not.toEqual(cacheIdentity(withSupplements(), 'synthetic'));
    expect(cacheIdentity(first, 'synthetic')).not.toEqual(cacheIdentity(withSupplements({ ...value,
      locations: value.locations.map(l => ({ ...l, location: 'changed' })) }), 'synthetic'));
  });
  it('preserves the old serialized config and fingerprint when disabled or empty', () => {
    const original = validateConfig(config);
    for (const json of [undefined, '', '  ', 'null', JSON.stringify({ semester: config.semester, locations: [], courses: [] })]) {
      const result = configWithPrivateSupplements(config, json);
      expect(JSON.stringify(result)).toBe(JSON.stringify(original));
      expect(cacheIdentity(result, 'synthetic')).toEqual(cacheIdentity(original, 'synthetic'));
    }
    expect(() => withSupplements({ semester: '2025-2026-1', locations: [], courses: [] })).toThrow('supplements:invalid');
  });
  it('rejects public embedding and competing runtime inputs', () => {
    const { periods: _periods, ...source } = config;
    expect(() => validateSourceConfig({ ...source, timetable: 'pku-main', courseSupplements: supplements })).toThrow('configuration:invalid');
    expect(() => configWithPrivateSupplements(withSupplements(), 'null')).toThrow('supplements:invalid');
    expect(() => configWithPrivateSupplements(config, '{broken')).toThrow('supplements:invalid');
  });
  it('exposes only fixed error categories', () => {
    expect(errorCategory(new SupplementError('conflict'))).toBe('supplements:conflict');
  });
});
