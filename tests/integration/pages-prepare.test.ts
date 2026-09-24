import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeSnapshot } from '../../src/application/snapshot.js';
import { calendarIdentity } from '../../src/calendar/compare.js';
import { main, preparePages } from '../../src/entrypoints/pages-prepare.js';
import { newPagesToken, savePagesState, subscriptionUrl, validatePagesToken } from '../../src/entrypoints/pages-state.js';
import { generateFromHtml } from '../fixtures/pipeline.js';
import { config, course, timetable } from '../fixtures/timetable.js';

const token = Buffer.alloc(32, 1).toString('base64url');
const first = generateFromHtml(timetable(), config, new Date('2026-09-01T00:00:00Z'));
const second = generateFromHtml(timetable(), config, new Date('2026-09-02T00:00:00Z'));
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(response = new Response(first.ics)) {
  const directory = await mkdtemp(join(tmpdir(), 'pku-pages-'));
  directories.push(directory);
  return { token, baseUrl: 'https://calendar.test/project/', force: false, directory,
    snapshot: second, fetch: vi.fn<typeof fetch>(async () => response),
  };
}

it('ignores only event DTSTAMP, including folding and property/event order', () => {
  expect(first.ics).not.toBe(second.ics);
  expect(calendarIdentity(first.ics)).toBe(calendarIdentity(second.ics));
  const folded = first.ics.replace('SUMMARY:', 'SUM\r\n MARY:').replace(/\r\n/g, '\n');
  expect(calendarIdentity(folded)).toBe(calendarIdentity(first.ics));
  const blocks = first.ics.match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/g)!;
  const reordered = first.ics.slice(0, first.ics.indexOf('BEGIN:VEVENT')) + blocks.reverse().map(block => {
    const lines = block.trim().split('\r\n');
    // Unfold first, then permute complete logical properties.
    const properties = lines.slice(1, -1).join('\r\n').replace(/\r\n[ \t]/g, '').split('\r\n').reverse();
    return ['BEGIN:VEVENT', ...properties, 'END:VEVENT', ''].join('\r\n');
  }).join('') + 'END:VCALENDAR\r\n';
  expect(calendarIdentity(reordered)).toBe(calendarIdentity(first.ics));
});

it.each(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'UID', 'PRODID'])('detects changes to %s', field => {
  const changed = first.ics.replace(`${field}:`, `${field}:changed-`);
  expect(calendarIdentity(changed)).not.toBe(calendarIdentity(first.ics));
});

it('detects times, property parameters, course removal and a legitimate empty calendar', () => {
  const changed = first.ics.replace(/DTSTART:(\d{8})T\d{6}Z/, 'DTSTART:$1T000001Z');
  expect(calendarIdentity(changed)).not.toBe(calendarIdentity(first.ics));
  expect(calendarIdentity(first.ics.replace('SUMMARY:', 'SUMMARY;LANGUAGE=zh:'))).not.toBe(calendarIdentity(first.ics));
  const empty = generateFromHtml(timetable([]), config, new Date('2026-09-01')).ics;
  expect(calendarIdentity(empty)).not.toBe(calendarIdentity(first.ics));
  expect(calendarIdentity(empty)).toBe(calendarIdentity(generateFromHtml(timetable([]), config, new Date('2026-09-02')).ics));
});

it.each(['<html>error</html>', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'])('rejects invalid published content', value => {
  expect(() => calendarIdentity(value)).toThrow('pages:invalid_calendar');
});

it('does not prepare artifacts when only the generation timestamp changed', async () => {
  const options = await fixture();
  expect(await preparePages(options)).toEqual({ changed: false, reason: 'unchanged' });
  expect(await readdir(options.directory)).toEqual([]);
  const [url, request] = options.fetch.mock.calls[0]!;
  expect(url).toBe(`https://calendar.test/project/${token}/calendar.ics`);
  expect(request).toMatchObject({ redirect: 'error', headers: { 'cache-control': 'no-cache' } });
  expect(request?.signal).toBeInstanceOf(AbortSignal);
});

it.each(['missing', 'changed', 'forced'] as const)('stages only the new token path when %s', async reason => {
  const options = await fixture(reason === 'missing' ? new Response(null, { status: 404 }) : new Response(first.ics.replace('SUMMARY:', 'SUMMARY:old-')));
  options.force = reason === 'forced';
  await writeFile(join(options.directory, 'calendar.ics'), 'old root file');
  await savePagesState(join(options.directory, 'old-token', 'calendar.ics'), 'old token file');
  expect(await preparePages(options)).toEqual({ changed: true, reason });
  expect(await readdir(options.directory)).toEqual([token]);
  expect(await readFile(join(options.directory, token, 'calendar.ics'), 'utf8')).toBe(second.ics);
  expect(options.fetch).toHaveBeenCalledTimes(reason === 'forced' ? 0 : 1);
});

it.each([301, 403, 429, 500, 503])('does not publish after HTTP %s', async status => {
  const options = await fixture(new Response('private contents', { status }));
  await expect(preparePages(options)).rejects.toThrow('pages:comparison_failed');
  expect(await readdir(options.directory)).toEqual([]);
});

it('redacts URL-bearing network failures and invalid ICS', async () => {
  const options = await fixture(new Response('not a calendar'));
  await expect(preparePages(options)).rejects.toThrow('pages:comparison_failed');
  options.fetch.mockRejectedValue(new Error(`timeout https://calendar.test/${token} private body`));
  await expect(preparePages(options)).rejects.toThrow(/^pages:comparison_failed$/);
});

it('never stages or fetches after generation failure, even if forced', async () => {
  const options = await fixture();
  options.force = true;
  options.snapshot = { ...second, ics: 'broken' };
  await expect(preparePages(options)).rejects.toThrow('pages:invalid_calendar');
  expect(options.fetch).not.toHaveBeenCalled();
  expect(await readdir(options.directory)).toEqual([]);
});

it('validates secret paths and supports actual Pages base paths', () => {
  expect(validatePagesToken(newPagesToken())).toHaveLength(43);
  for (const invalid of ['', '../secret', 'a'.repeat(43), 'a'.repeat(44)]) expect(() => validatePagesToken(invalid)).toThrow();
  expect(subscriptionUrl('https://calendar.test', token)).toBe(`https://calendar.test/${token}/calendar.ics`);
  for (const invalid of ['http://calendar.test', 'https://user:pass@calendar.test', 'https://calendar.test/?q=x']) expect(() => subscriptionUrl(invalid, token)).toThrow();
});

it('stores private state atomically with restrictive permissions', async () => {
  const { directory } = await fixture();
  const path = join(directory, 'owner', 'repo.json');
  await savePagesState(path, 'first');
  await savePagesState(path, 'second');
  expect(await readFile(path, 'utf8')).toBe('second');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(directory, 'owner'))).toEqual(['repo.json']);
});

it('detects added courses, teacher edits, holiday and makeup changes', () => {
  const now = new Date('2026-09-01');
  const variants = [
    generateFromHtml(timetable([{ course }, { course: { ...course, courseId: 'SYN999' } }]), config, now),
    generateFromHtml(timetable([{ course: { ...course, teacher: 'changed teacher' } }]), config, now),
    generateFromHtml(timetable(), { ...config, holidays: ['2026-09-07'] }, now),
    generateFromHtml(timetable(), { ...config, makeups: { '2026-09-08': '2026-09-07' } }, now),
  ];
  for (const variant of variants) expect(calendarIdentity(variant.ics)).not.toBe(calendarIdentity(first.ics));
});

it('rejects truncated events, missing fields and duplicate identities', () => {
  const event = first.ics.match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/)![0];
  for (const invalid of [
    first.ics.replace('END:VEVENT\r\n', ''),
    first.ics.replace(/DTSTART:[^\r]+/, 'DTSTART:20260231T000000Z'),
    first.ics.replace(/DTSTART:[^\r]+\r\n/, ''),
    first.ics.replace(/DTSTAMP:[^\r]+\r\n/, ''),
    first.ics.replace('END:VCALENDAR', event + 'END:VCALENDAR'),
  ]) expect(() => calendarIdentity(invalid)).toThrow('pages:invalid_calendar');
});

it('emits the runner masking command first and redacts CLI diagnostics', async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(value => { errors.push(String(value)); });
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  const payload = encodeSnapshot(second, token);
  vi.stubEnv('PAGES_CALENDAR_SNAPSHOT', payload.encoded);
  vi.stubEnv('PAGES_SNAPSHOT_ID', payload.digest);
  vi.stubEnv('PAGES_FORCE_PUBLISH', 'invalid-private-value');
  const exitCode = process.exitCode;
  try {
    await main();
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual([`::add-mask::${token}`]);
    expect(errors.join('')).not.toMatch(new RegExp(`${token}|invalid-private-value`));
  } finally { process.exitCode = exitCode; }
});
