import { describe, expect, it, vi } from 'vitest';
import { validateConfig, type CalendarConfig } from '../../src/application/config.js';
import { generateFromHtml } from '../fixtures/pipeline.js';
import { importSchedule } from '../../src/application/import.js';
import { assertGenerationAllowed } from '../../src/application/semester.js';
import { config, course, timetable } from '../fixtures/timetable.js';
import { upstream } from '../fixtures/upstream.js';
import { generateKeyPairSync } from 'node:crypto';

const bound: CalendarConfig = {
  ...config,
  semesterBinding: { confirmedSemester: config.semester, validFrom: '2026-09-01', validThrough: '2026-09-30' },
};
const now = new Date('2026-09-24T00:00:00Z');

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
    await expect(importSchedule(bound, { username: 'synthetic', password: 'synthetic' }, {
      fetch, now: () => new Date('2026-10-01T00:00:00Z'),
    })).rejects.toThrow('semester:expired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks time when an upstream request crosses the expiry boundary', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const clock = vi.fn().mockReturnValueOnce(new Date('2026-09-30T15:59:59.999Z')).mockReturnValue(new Date('2026-09-30T16:00:00Z'));
    await expect(importSchedule(bound, { username: 'synthetic', password: 'synthetic' }, {
      fetch: upstream(pem, timetable()), now: clock,
    })).rejects.toThrow('semester:expired');
  });
  it('does not affect event identities', () => {
    const original = generateFromHtml(timetable(), config, now);
    expect(generateFromHtml(timetable(), bound, now)).toEqual(original);
  });
});
