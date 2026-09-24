import { describe, expect, it, vi } from 'vitest';
import { configWithPrivateConfirmations, validateConfig, type CalendarConfig } from '../../src/migration/config.js';
import { generateFromHtml } from '../fixtures/legacy.js';
import { importSchedule as generateCalendar } from '../../src/application/import.js';
import { assertGenerationAllowed } from '../../src/application/semester.js';
import { expandCourses } from '../fixtures/legacy.js';
import { config, course, timetable } from '../fixtures/timetable.js';
import { upstream } from '../fixtures/upstream.js';
import { generateKeyPairSync } from 'node:crypto';

export const bound: CalendarConfig = {
  ...config,
  semesterBinding: { confirmedSemester: config.semester, validFrom: '2026-09-01', validThrough: '2026-09-30' },
};
const now = new Date('2026-09-24T00:00:00Z');
const unscheduled = { ...course, courseId: 'SYN002', segments: ['(合成无固定时间说明)'] };
const decision = { semester: config.semester, courseId: unscheduled.courseId, classId: unscheduled.classId, confirmed: true as const, expectedSegments: unscheduled.segments };

describe('explicit semester confirmation', () => {
  it('allows a missing semester only with a valid explicit binding', () => {
    const html = timetable([{ course }], '学期课程表');
    expect(generateFromHtml(html, bound, now).ics).toContain('BEGIN:VEVENT');
    expect(() => generateFromHtml(html, config, now)).toThrow('parse:semester');
    expect(() => generateFromHtml(timetable([], '2025-2026学年第一学期'), bound, now)).toThrow('parse:semester');
  });
  it.each([
    ['2026-08-31T15:59:59.999Z', 'semester:not_started'],
    ['2026-08-31T16:00:00.000Z', null],
    ['2026-09-30T15:59:59.999Z', null],
    ['2026-09-30T16:00:00.000Z', 'semester:expired'],
  ])('uses inclusive Shanghai dates at %s', (value, error) => {
    if (error) expect(() => assertGenerationAllowed(bound, new Date(value))).toThrow(error);
    else expect(() => assertGenerationAllowed(bound, new Date(value))).not.toThrow();
  });
  it.each([
    { confirmedSemester: '2025-2026-1', validFrom: '2026-09-01', validThrough: '2026-09-30' },
    { confirmedSemester: config.semester, validFrom: '2026-10-01', validThrough: '2026-09-30' },
    { confirmedSemester: config.semester, validFrom: '2026-02-30', validThrough: '2026-09-30' },
    { confirmedSemester: config.semester, validFrom: '2026-09-01' },
  ])('rejects invalid binding %#', semesterBinding => {
    expect(() => validateConfig({ ...config, semesterBinding })).toThrow('configuration:invalid');
  });
  it('does not contact upstream outside the window', async () => {
    const fetch = vi.fn();
    await expect(generateCalendar(bound, { username: 'synthetic', password: 'synthetic' }, {
      fetch, now: () => new Date('2026-10-01T00:00:00Z'),
    })).rejects.toThrow('semester:expired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks time when an upstream request crosses the expiry boundary', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const clock = vi.fn().mockReturnValueOnce(new Date('2026-09-30T15:59:59.999Z')).mockReturnValue(new Date('2026-09-30T16:00:00Z'));
    await expect(generateCalendar(bound, { username: 'synthetic', password: 'synthetic' }, {
      fetch: upstream(pem, timetable()), now: clock,
    })).rejects.toThrow('semester:expired');
  });
  it('does not affect event identities', () => {
    const original = generateFromHtml(timetable(), config, now);
    expect(generateFromHtml(timetable(), bound, now)).toEqual(original);
  });
});

describe('manual unscheduled-course confirmations', () => {
  it('does not infer a confirmation from missing times', () => {
    expect(() => expandCourses([unscheduled], config)).toThrow('schedule:time');
  });
  it('omits only the explicitly matched course and preserves all remaining identities', () => {
    const confirmed = { ...config, unscheduledCourses: [decision] };
    expect(expandCourses([course, unscheduled], confirmed)).toEqual(expandCourses([course], config));
    expect(() => expandCourses([{ ...unscheduled, classId: 'different' }], confirmed)).toThrow('schedule:time');
  });
  it('fails when confirmed upstream text changes', () => {
    expect(() => expandCourses([{ ...unscheduled, segments: ['(新的说明)'] }], { ...config, unscheduledCourses: [decision] })).toThrow('schedule:unscheduled_changed');
    expect(() => expandCourses([{ ...unscheduled, segments: ['1~4周 周一1节'] }], { ...config, unscheduledCourses: [decision] })).toThrow('schedule:unscheduled_changed');
  });
  it('rejects labeling a parseable timed course as unscheduled', () => {
    expect(() => expandCourses([course], { ...config, unscheduledCourses: [{ ...decision, courseId: course.courseId, expectedSegments: course.segments }] })).toThrow('schedule:unscheduled_has_time');
  });
  it('permits an absent confirmed course after cancellation', () => {
    expect(expandCourses([course], { ...config, unscheduledCourses: [decision] })).toEqual(expandCourses([course], config));
  });
  it('can produce a valid empty calendar when every enrolled course is confirmed unscheduled', () => {
    const result = generateFromHtml(timetable([{ course: unscheduled }], '学期课程表'), { ...bound, unscheduledCourses: [decision] }, now);
    expect(result.ics).toContain('BEGIN:VCALENDAR');
    expect(result.ics).not.toContain('BEGIN:VEVENT');
  });
  it.each([
    [{ ...decision, confirmed: false }], [{ ...decision, semester: '2025-2026-1' }],
    [{ ...decision, expectedSegments: [] }], [decision, decision],
  ].map(unscheduledCourses => ({ unscheduledCourses })))('requires valid explicit per-semester confirmation %#', ({ unscheduledCourses }) => {
    expect(() => validateConfig({ ...config, unscheduledCourses })).toThrow('configuration:invalid');
  });
  it('reads private JSON without overriding another source', () => {
    expect(configWithPrivateConfirmations(config, JSON.stringify([decision])).unscheduledCourses).toEqual([decision]);
    expect(configWithPrivateConfirmations(config, '')).toEqual(validateConfig(config));
    expect(() => configWithPrivateConfirmations(config, '{bad}')).toThrow('configuration:invalid');
    expect(() => configWithPrivateConfirmations({ ...config, unscheduledCourses: [] }, '[]')).toThrow('configuration:invalid');
  });
});
