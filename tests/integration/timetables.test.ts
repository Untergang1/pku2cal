import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { TimetableConfigError, validateConfig, validateSourceConfig } from '../../src/application/config.js';
import { generateCalendar, generateFromHtml } from '../../src/application/generate.js';
import { resolveCalendarConfig } from '../../src/entrypoints/calendar-config.js';
import { generateFile } from '../../src/entrypoints/node.js';
import { preparePages } from '../../src/entrypoints/pages-prepare.js';
import { cacheIdentity, createWorker, type CalendarStore } from '../../src/entrypoints/worker.js';
import { expandCourses } from '../../src/schedule/expand.js';
import { config as synthetic, course, timetable } from '../fixtures/timetable.js';
import { upstream } from '../fixtures/upstream.js';

// Public pre-migration config: a regression baseline, not a supported input format.
const before = JSON.parse(await readFile(new URL('../fixtures/calendar-main.json', import.meta.url), 'utf8'));
const source = { ...JSON.parse(await readFile(new URL('../../config/pku-main-2026-2027-1.json', import.meta.url), 'utf8')), semesterBinding: before.semesterBinding };
const now = new Date('2026-09-24T02:00:00Z');
const { periods, ...fields } = synthetic;
const customSource = { ...fields, timetable: 'pku-main' };
const tables = {
  'pku-main': { label: '合成本部', periods },
  'pku-ss': { label: '合成软微（非真实作息）', periods: periods.map(p => ({ ...p, start: p.start.replace(':00', ':05'), end: p.end.replace(':50', ':55') })) },
};
const directories: string[] = [];
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'pku-timetable-')); directories.push(path); return path;
}
const readSynthetic = async (file: URL) => JSON.stringify(file.pathname.endsWith('/pku-main.json') ? tables['pku-main'] : tables['pku-ss']);

it('preserves canonical config, bytes, UIDs and the existing Worker fingerprint on migration', async () => {
  const { config } = await resolveCalendarConfig(source);
  expect(JSON.stringify(config)).toBe(JSON.stringify(before));
  expect(generateFromHtml(timetable(), config, now)).toEqual(generateFromHtml(timetable(), validateConfig(before), now));
  expect(cacheIdentity(config, 'synthetic').fingerprint).toBe('b0588254905f2eef969504071f6bf7362f51f2b73a019168eff9bad9beca9792');
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
  expect(cacheIdentity(first.config, 'synthetic')).toEqual(cacheIdentity(other.config, 'synthetic'));
});

it('switches times without changing UIDs and isolates caches after selection or table edits', async () => {
  const a = (await resolveCalendarConfig(customSource, readSynthetic)).config;
  const b = (await resolveCalendarConfig({ ...customSource, timetable: 'pku-ss' }, readSynthetic)).config;
  const eventsA = expandCourses([course], a);
  const eventsB = expandCourses([course], b);
  expect(eventsA.map(e => e.uid)).toEqual(eventsB.map(e => e.uid));
  expect(eventsA[0]!.start).toBe('2026-09-07T00:00:00.000Z');
  expect(eventsB[0]!.start).toBe('2026-09-07T00:05:00.000Z');
  expect(eventsB[0]!.end).toBe('2026-09-07T01:55:00.000Z');
  expect(cacheIdentity(a, 'synthetic')).not.toEqual(cacheIdentity(b, 'synthetic'));
  const edited = (await resolveCalendarConfig(customSource, async () => JSON.stringify(tables['pku-ss']))).config;
  expect(cacheIdentity(edited, 'synthetic')).toEqual(cacheIdentity(b, 'synthetic'));
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
  expect(() => generateFromHtml(timetable(), config, now)).toThrow('schedule:periods');
});

it.each(['pku-main', 'pku-ss'])('uses the selected %s table consistently in Node, Pages and Worker', async id => {
  const { config } = await resolveCalendarConfig({ ...customSource, timetable: id }, readSynthetic);
  const dir = await directory();
  const output = join(dir, 'node.ics');
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const dependencies = { fetch: upstream(pem, timetable()), now: () => now };
  const credentials = { username: 'synthetic', password: 'synthetic-password' };
  await generateFile({ config, output, credentials, dependencies });
  const bytes = await readFile(output, 'utf8');
  const data = new Map<string, string>();
  const store: CalendarStore = { get: async key => data.get(key) ?? null, put: async (key, value) => { data.set(key, value); } };
  const token = Buffer.alloc(32, 1).toString('base64url');
  const worker = createWorker(config, { ...dependencies, log: () => {} });
  const response = await worker.fetch(new Request(`https://calendar.test/calendar/${token}.ics`), { CALENDAR_TOKEN: token, PKU_USERNAME: credentials.username, PKU_PASSWORD: credentials.password, CALENDAR_KV: store });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(bytes);
  await preparePages({ token, baseUrl: 'https://calendar.test/project/', force: false, directory: join(dir, 'site'),
    generate: () => generateCalendar(config, credentials, dependencies), fetch: async () => new Response(null, { status: 404 }), assertAllowed: () => {},
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
