import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { parseTime } from '../../src/schedule/time.js';
import { expandCourses } from '../../src/schedule/expand.js';
import { parseTimetable } from '../../src/pku/parser.js';
import { validateConfig } from '../../src/application/config.js';
import { generateFromHtml } from '../../src/application/generate.js';
import { serializeCalendar } from '../../src/calendar/ics.js';
import { config, course, timetable } from '../fixtures/timetable.js';

const now = new Date('2026-09-01T00:00:00Z');

describe('HTML contracts', () => {
  it('keeps identity and br boundaries, including extra columns', () => {
    expect(parseTimetable(timetable()).courses).toEqual([course]);
    expect(parseTimetable(timetable()).semester).toBe(config.semester);
  });
  it('excludes only explicitly unsuccessful courses', () => {
    expect(parseTimetable(timetable([{ status: '未选上' }])).courses).toEqual([]);
    expect(() => parseTimetable(timetable([{ status: '未知' }]))).toThrow('parse:status');
  });
  it('accepts a structured empty table, rejects broken pages', () => {
    expect(parseTimetable(timetable([])).courses).toEqual([]);
    expect(() => parseTimetable('<html>维护中</html>')).toThrow('parse:structure');
    expect(() => parseTimetable(timetable().replace('课程号', '序号'))).toThrow('parse:structure');
    expect(() => parseTimetable(timetable().replace('Page 1 of 1', 'Page 1 of 2'))).toThrow('parse:pagination');
    expect(() => parseTimetable(timetable([{ course }, { course }]))).toThrow('parse:identity');
  });
  it('rejects a wrong or missing semester before calendar generation', () => {
    expect(() => generateFromHtml(timetable([], '学期课程表'), config, now)).toThrow('parse:semester');
    expect(() => generateFromHtml(timetable([], '2025-2026学年第一学期'), config, now)).toThrow('parse:semester');
  });
});

describe('time and calendar expansion', () => {
  it.each([
    ['1~4周 每周周一1~2节(示例教室)', [1, 2, 3, 4]],
    ['1~4周 单周周一1~2节 示例教室', [1, 3]],
    ['1~4周 双周周一1~2节 示例教室', [2, 4]],
    ['1~4周 周一1~2节(单) 示例教室', [1, 3]],
    ['1,3~4周 周一1节', [1, 3, 4]],
    ['1～4周 周一1～2节（双） 示例教室', [2, 4]],
  ])('%s', (input, weeks) => expect(parseTime(input as string, 4).weeks).toEqual(weeks));
  it.each(['0~4周 周一1节', '4~1周 周一1节', '1~5周 周一1节', '1~4周 周八1节', '1周 周一3~2节', '待定', '(另行通知)', '1~4周 单周周一1节(双)'])('rejects %s', input => {
    expect(() => parseTime(input, 4)).toThrow();
  });
  it('uses Shanghai times and expands multiple slots', () => {
    const events = expandCourses([course], config);
    expect(events).toHaveLength(6);
    expect(events[0]!.start).toBe('2026-09-07T00:00:00.000Z');
    expect(events[0]!.end).toBe('2026-09-07T01:50:00.000Z');
  });
  it('moves the standard day even if its original date is a holiday, replacing the target', () => {
    const base = expandCourses([course], config);
    const moved = expandCourses([course], { ...config, holidays: ['2026-09-07'], makeups: { '2026-09-09': '2026-09-07' } });
    expect(moved).toHaveLength(5);
    expect(moved.find(e => e.uid === base[0]!.uid)?.start).toBe('2026-09-09T00:00:00.000Z');
    expect(moved.some(e => e.originalDate === '2026-09-09')).toBe(false);
    expect(expandCourses([course], { ...config, holidays: ['2026-09-07'] })).toHaveLength(5);
  });
  it('keeps UIDs across cosmetic edits, reorderings, regeneration and moves', () => {
    const base = expandCourses([course], config).map(e => e.uid).sort();
    const edited = { ...course, name: '改名', teacher: '另一教师', segments: [...course.segments].reverse().map(s => s.replace('教室', '场所')) };
    expect(expandCourses([edited], config).map(e => e.uid).sort()).toEqual(base);
    expect(expandCourses([course], { ...config, makeups: { '2026-09-12': '2026-09-07' } }).map(e => e.uid).sort()).toEqual(base);
    expect(expandCourses([course], { ...config, semester: '2027-2028-1' })[0]!.uid).not.toBe(base[0]);
  });
  it('rejects overlapping identities and missing periods', () => {
    expect(() => expandCourses([{ ...course, segments: [...course.segments, course.segments[0]!] }], config)).toThrow('schedule:duplicate');
    expect(() => expandCourses([course], { ...config, periods: config.periods.slice(0, 1) })).toThrow('schedule:periods');
  });
  it.each([
    { firstMonday: '2026-09-08' }, { firstMonday: '2026-02-30' }, { teachingWeeks: 0 },
    { makeups: { '2026-09-09': '2026-09-07', '2026-09-10': '2026-09-07' } },
    { makeups: { '2026-09-09': '2026-09-07', '2026-09-07': '2026-09-08' } },
    { makeups: { '2026-09-09': '2026-09-07' }, holidays: ['2026-09-09'] },
    { makeups: { '2026-09-09': '2026-08-31' } },
    { periods: [{ period: 1, start: '09:00', end: '08:00' }] },
  ])('rejects invalid configuration %#', patch => expect(() => validateConfig({ ...config, ...patch })).toThrow('configuration:invalid'));
});

describe('ICS interoperability', () => {
  it('round-trips Chinese, punctuation, newlines and multibyte folds through an independent parser', () => {
    const name = '中文😀'.repeat(35) + '\\,;\n注入:END:VEVENT';
    const events = expandCourses([{ ...course, name }], config);
    const ics = serializeCalendar(events, now);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const calendar = new ICAL.Component(ICAL.parse(ics));
    const vevents = calendar.getAllSubcomponents('vevent');
    expect(vevents).toHaveLength(6);
    const first = new ICAL.Event(vevents[0]!);
    expect(first.summary).toBe(name);
    expect(first.startDate.toJSDate().toISOString()).toBe(events[0]!.start);
    expect(first.endDate.toJSDate().toISOString()).toBe(events[0]!.end);
  });
  it('is deterministic and supports valid empty calendars', () => {
    const a = generateFromHtml(timetable(), config, now);
    const b = generateFromHtml(timetable([{ course: { ...course, segments: [...course.segments].reverse() } }]), config, now);
    expect(a.ics).toBe(b.ics);
    expect(new ICAL.Component(ICAL.parse(generateFromHtml(timetable([]), config, now).ics)).getAllSubcomponents('vevent')).toEqual([]);
  });
  it('rejects invalid event fields', () => {
    const events = expandCourses([course], config);
    expect(() => serializeCalendar([{ ...events[0]!, summary: '\0bad' }], now)).toThrow();
    expect(() => serializeCalendar([{ ...events[0]!, end: events[0]!.start }], now)).toThrow();
    expect(() => serializeCalendar(events, new Date('bad'))).toThrow();
  });
});
