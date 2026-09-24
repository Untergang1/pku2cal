import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { TimetableConfigError, validateConfig, validateSourceConfig } from '../../src/application/config.js';
import { generateFromHtml } from '../fixtures/pipeline.js';
import { importFromHtml } from '../../src/application/import.js';
import { generateCalendar } from '../../src/application/generate.js';
import { resolveCalendarConfig } from '../../src/entrypoints/calendar-config.js';
import { generateFile } from '../../src/entrypoints/node.js';
import { preparePages } from '../../src/entrypoints/pages-prepare.js';
import { createWorker } from '../../src/entrypoints/worker.js';
import { expandCourses } from '../fixtures/pipeline.js';
import { config as synthetic, course, timetable } from '../fixtures/timetable.js';

// Public pre-migration config: a regression baseline, not a supported input format.
const before = JSON.parse(await readFile(new URL('../fixtures/calendar-main.json', import.meta.url), 'utf8'));
const source = { ...JSON.parse(await readFile(new URL('../../config/pku-main-2026-2027-1.json', import.meta.url), 'utf8')), semesterBinding: before.semesterBinding };
const now = new Date('2026-09-24T02:00:00Z');
const { periods, ...fields } = synthetic;
const customSource = { ...fields, timetable: 'pku-main' };
const tables = {
  'pku-main': { label: '合成本部', periods },
  'pku-ss': { label: '合成软微（非真实作息）', periods: [
    ...periods.map(p => ({ ...p, start: p.start.replace(':00', ':05'), end: p.end.replace(':50', ':55') })),
    { period: 5, start: '14:00', end: '14:50' },
    { period: 6, start: '15:00', end: '15:50' },
    { period: 7, start: '16:00', end: '16:50' },
    { period: 8, start: '13:00', end: '13:50' },
    { period: 9, start: '18:00', end: '18:50' },
  ] },
};
const directories: string[] = [];
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'pku-timetable-')); directories.push(path); return path;
}
const readSynthetic = async (file: URL) => JSON.stringify(file.pathname.endsWith('/pku-main.json') ? tables['pku-main'] : tables['pku-ss']);

it('preserves canonical config, bytes, UIDs on migration', async () => {
  const { config } = await resolveCalendarConfig(source);
  expect(JSON.stringify(config)).toBe(JSON.stringify(before));
  expect(generateFromHtml(timetable(), config, now)).toEqual(generateFromHtml(timetable(), validateConfig(before), now));
});

it('reads only the selected table and ignores changes to unselected tables and labels', async () => {
  const read = vi.fn(readSynthetic);
  const first = await resolveCalendarConfig(customSource, read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![0].pathname).toMatch(/\/config\/timetables\/pku-main.json$/);
  const other = await resolveCalendarConfig(customSource, async file => {
    if (!file.pathname.endsWith('/pku-main.json')) throw new Error('unselected draft is invalid');
    return JSON.stringify({ ...tables['pku-main'], label: 'renamed' });
  });
  expect(first.config).toEqual(other.config);
});

it('switches times without changing UIDs', async () => {
  const a = (await resolveCalendarConfig(customSource, readSynthetic)).config;
  const b = (await resolveCalendarConfig({ ...customSource, timetable: 'pku-ss' }, readSynthetic)).config;
  const eventsA = expandCourses([course], a);
  const eventsB = expandCourses([course], b);
  expect(eventsA.map(e => e.uid)).toEqual(eventsB.map(e => e.uid));
  expect(eventsA[0]!.start).toBe('2026-09-07T00:00:00.000Z');
  expect(eventsB[0]!.start).toBe('2026-09-07T00:05:00.000Z');
  expect(eventsB[0]!.end).toBe('2026-09-07T01:55:00.000Z');
  const edited = (await resolveCalendarConfig(customSource, async () => JSON.stringify(tables['pku-ss']))).config;
  expect(edited).toEqual(b);
});

it.each([
  before, { ...source, periods: [] }, { ...source, timetable: undefined },
  { ...source, timetable: 'unknown' }, { ...source, timetable: '../../private' },
])('rejects obsolete, mixed or unknown selection input %# before reading files', async input => {
  const read = vi.fn(readSynthetic);
  await expect(resolveCalendarConfig(input, read)).rejects.toBeInstanceOf(TimetableConfigError);
  expect(read).not.toHaveBeenCalled();
});

it.each([
  null, { label: 'draft', periods: [] }, { label: '', periods },
  { label: 'bad', periods: [{ period: 1, start: '25:00', end: '26:00' }] },
  { label: 'bad', periods: [{ period: 1, start: '09:00', end: '08:00' }] },
  { label: 'bad', periods: [periods[0], periods[0]] },
  { label: 'bad', periods: [periods[0], { period: 2, start: '08:30', end: '09:00' }] },
])('rejects invalid selected tables %#', async table => {
  await expect(resolveCalendarConfig(customSource, async () => JSON.stringify(table))).rejects.toMatchObject({ guidance: expect.stringContaining('config/timetables/pku-main.json') });
});

it('rejects absent files, malformed JSON and an empty SS draft without leaking contents', async () => {
  for (const read of [async () => { throw new Error('private-path'); }, async () => 'private invalid contents']) {
    await expect(resolveCalendarConfig(customSource, read)).rejects.toMatchObject({ guidance: expect.not.stringContaining('private') });
  }
  await expect(resolveCalendarConfig({ ...source, timetable: 'pku-ss' }, async () => JSON.stringify({ label: '合成软微草稿', periods: [] }))).rejects.toMatchObject({ guidance: expect.stringContaining('config/timetables/pku-ss.json') });
  await expect(resolveCalendarConfig(source)).resolves.toHaveProperty('config.periods');
});

it('rejects a course referring to a missing period after table resolution', async () => {
  const { config } = await resolveCalendarConfig(customSource, async () => JSON.stringify({ label: 'partial', periods: periods.slice(0, 1) }));
  expect(() => generateFromHtml(timetable(), config, now)).toThrow('缺少节次');
});

it.each(['pku-main', 'pku-ss'])('uses the selected %s table consistently in Node, Pages and Worker', async id => {
  const { config } = await resolveCalendarConfig({ ...customSource, timetable: id }, readSynthetic);
  const dir = await directory();
  const output = join(dir, 'node.ics');
  const html = timetable([{ course: { ...course, segments: id === 'pku-ss' ? [...course.segments, '1周 周三5~7节', '1周 周四5~8节', '1周 周五8节'] : course.segments } }]);
  const document = importFromHtml(html, config, now);
  await generateFile({ config, document, output, now });
  const bytes = await readFile(output, 'utf8');
  const snapshot = generateCalendar(document, config, now);
  const token = Buffer.alloc(32, 1).toString('base64url');
  const response = await createWorker(snapshot).fetch(new Request(`https://calendar.test/calendar/${token}.ics`), { CALENDAR_TOKEN: token });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(bytes);
  await preparePages({ token, baseUrl: 'https://calendar.test/project/', force: false, directory: join(dir, 'site'),
    snapshot, fetch: async () => new Response(null, { status: 404 }),
  });
  expect(await readFile(join(dir, 'site', token, 'calendar.ics'), 'utf8')).toBe(bytes);
});

it('checks selection through the built status CLI with calendar and cwd outside the repository', async () => {
  const dir = await directory();
  const path = join(dir, 'calendar.json');
  const cli = fileURLToPath(new URL('../../dist/entrypoints/node.js', import.meta.url));
  await writeFile(path, JSON.stringify(validateSourceConfig(source)));
  const status = spawnSync(process.execPath, [cli, '--status', '--config', path], { cwd: dir, encoding: 'utf8' });
  expect(status.status, status.stderr).toBe(0);
  expect(status.stdout).toContain('北京大学校本部（pku-main）');
  await writeFile(path, JSON.stringify({ ...source, timetable: 'unknown' }));
  const draft = spawnSync(process.execPath, [cli, '--status', '--config', path], { cwd: dir, encoding: 'utf8' });
  expect(draft.status).toBe(1);
  expect(draft.stderr).toContain('timetable: "pku-main" 或 "pku-ss"');
});


it('maps period 8 to lunchtime, preserves its UID and keeps canonical number order', async () => {
  const { config } = await resolveCalendarConfig({ ...customSource, timetable: 'pku-ss' }, readSynthetic);
  const mapped = { ...course, segments: ['1周 周一8节'] };
  const events = expandCourses([mapped], config);
  expect(events[0]).toMatchObject({ start: '2026-09-07T05:00:00.000Z', end: '2026-09-07T05:50:00.000Z' });
  const original = { ...config, periods: config.periods.map(p => p.period === 8 ? { ...p, start: '17:00', end: '17:50' } : p) };
  expect(events[0]!.uid).toBe(expandCourses([mapped], original)[0]!.uid);
  const reordered = validateConfig({ ...config, periods: [...config.periods].reverse() });
  expect(reordered.periods.map(p => p.period)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ics = generateFromHtml(timetable([{ course: mapped }]), config, now).ics;
  expect(ics).toContain('DTSTART:20260907T050000Z');
  expect(ics).toContain('DTEND:20260907T055000Z');
  expect(() => expandCourses([{ ...course, segments: ['1周 周一5~7节'] }], config)).not.toThrow();
});

it.each([
  ['5~7', '06:00', '08:50'],
  ['5~8', '05:00', '08:50'],
  ['7~8', '05:00', '08:50'],
  ['5~9', '05:00', '10:50'],
])('uses all mapped clock times for the actual SS %s period range', async (range, start, end) => {
  const { config } = await resolveCalendarConfig({ ...customSource, timetable: 'pku-ss' });
  const mapped = { ...course, segments: [`1周 周一${range}节`] };
  const event = expandCourses([mapped], config)[0]!;
  expect(event).toMatchObject({ start: `2026-09-07T${start}:00.000Z`, end: `2026-09-07T${end}:00.000Z` });
  const chronological = { ...config, periods: config.periods.map(p => p.period === 8 ? { ...p, start: '17:00', end: '17:50' } : p) };
  expect(event.uid).toBe(expandCourses([mapped], chronological)[0]!.uid);
  const ics = generateFromHtml(timetable([{ course: mapped }]), config, now).ics;
  expect(ics).toContain(`DTSTART:20260907T${start!.replace(':', '')}00Z`);
  expect(ics).toContain(`DTEND:20260907T${end!.replace(':', '')}00Z`);
});

it('still rejects real overlap between non-adjacent period numbers', async () => {
  const overlapping = { ...tables['pku-ss'], periods: tables['pku-ss'].periods.map(p => p.period === 8 ? { ...p, start: '14:30', end: '15:20' } : p) };
  await expect(resolveCalendarConfig({ ...customSource, timetable: 'pku-ss' }, async () => JSON.stringify(overlapping))).rejects.toBeInstanceOf(TimetableConfigError);
});
