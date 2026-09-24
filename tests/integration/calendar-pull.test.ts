import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { importCalendar } from '../../src/application/calendar-pull.js';
import { importFromHtml } from '../../src/application/import.js';
import { encodeSnapshot, decodeSnapshot } from '../../src/application/snapshot.js';
import { main, pullCalendarFile } from '../../src/entrypoints/calendar-pull.js';
import { readCalendar, readLocalSnapshot } from '../../src/entrypoints/local-data.js';
import { preparePages } from '../../src/entrypoints/pages-prepare.js';
import { createWorker } from '../../src/entrypoints/worker.js';
import { writeScheduleYaml } from '../../src/schedule/document.js';
import { academicCalendar } from '../fixtures/academic-calendar.js';
import { timetable } from '../fixtures/timetable.js';

const now = new Date('2026-09-24T00:00:00Z');
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pku-calendar-')); directories.push(directory);
  const load = vi.fn<Parameters<typeof pullCalendarFile>[0]['load']>(previous => importCalendar({
    ...(previous ? { previous } : {}), now, fetch: async () => new Response(academicCalendar()),
  }));
  return { directory, output: join(directory, 'calendar.json'), backups: join(directory, 'backups'), overwrite: false, dryRun: false, load };
}

it('creates a usable private config and refuses replacement before fetching', async () => {
  const f = await fixture();
  const result = await pullCalendarFile(f);
  expect(JSON.parse(await readFile(f.output, 'utf8'))).toEqual(result.config);
  expect((await stat(f.output)).mode & 0o777).toBe(0o600);
  expect((await readCalendar(f.output)).config.firstMonday).toBe('2026-09-07');
  await expect(pullCalendarFile(f)).rejects.toThrow('--overwrite');
  expect(f.load).toHaveBeenCalledTimes(1);
  expect(await readdir(f.directory)).toEqual(['calendar.json']);
});

it('backs up exact original bytes while retaining identity and timetable choices', async () => {
  const f = await fixture();
  const initial = await f.load(undefined);
  const custom = { ...initial.config, namespace: 'custom-namespace', timetable: 'pku-main',
    holidays: ['2026-09-08'], makeups: { '2026-09-09': '2026-09-07' } };
  const original = JSON.stringify(custom, null, 4) + '\n';
  await writeFile(f.output, original);
  const result = await pullCalendarFile({ ...f, overwrite: true });
  const backups = await readdir(f.backups);
  expect(backups).toHaveLength(1);
  expect(await readFile(join(f.backups, backups[0]!), 'utf8')).toBe(original);
  expect(result.config).toMatchObject({ namespace: 'custom-namespace', timetable: 'pku-main', makeups: {} });
  expect(result.config.holidays).toEqual(initial.config.holidays);
});

it('refuses malformed existing files before fetching even with overwrite', async () => {
  const f = await fixture();
  await writeFile(f.output, 'broken draft');
  await expect(pullCalendarFile({ ...f, overwrite: true })).rejects.toThrow('配置损坏');
  expect(f.load).not.toHaveBeenCalled();
  expect(await readFile(f.output, 'utf8')).toBe('broken draft');
  expect(await readdir(f.directory)).toEqual(['calendar.json']);
});

it.each(['fetch', 'parse', 'edited', 'backup', 'invalid'])('preserves the target when %s fails', async kind => {
  const f = await fixture();
  const initial = await pullCalendarFile(f);
  const original = await readFile(f.output, 'utf8');
  if (kind === 'fetch') f.load.mockRejectedValue(new Error('network'));
  if (kind === 'parse') f.load.mockImplementation(previous => importCalendar({ previous: previous!, now, fetch: async () => new Response('<html>changed page</html>') }));
  if (kind === 'edited') f.load.mockImplementation(async () => { await writeFile(f.output, 'edited'); return initial; });
  if (kind === 'backup') await writeFile(f.backups, 'blocks backup directory');
  if (kind === 'invalid') f.load.mockResolvedValue({ ...initial, config: { ...initial.config, firstMonday: 'invalid' } });
  await expect(pullCalendarFile({ ...f, overwrite: true })).rejects.toThrow();
  expect(await readFile(f.output, 'utf8')).toBe(kind === 'edited' ? 'edited' : original);
  expect((await readdir(f.directory)).some(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
});

it('refuses concurrent writers and a newly created target during an initial fetch', async () => {
  const f = await fixture();
  const initial = await f.load(undefined);
  f.load.mockImplementation(async () => {
    await expect(pullCalendarFile(f)).rejects.toThrow('操作锁');
    await writeFile(f.output, 'created by editor');
    return initial;
  });
  await expect(pullCalendarFile(f)).rejects.toThrow('被修改');
  expect(await readFile(f.output, 'utf8')).toBe('created by editor');
  expect(await readdir(f.directory)).toEqual(['calendar.json']);
});

it('previews without creating directories, locks, backups or replacing existing files', async () => {
  const f = await fixture();
  const load = f.load.getMockImplementation()!;
  f.load.mockImplementation(async previous => {
    expect(await readdir(f.directory)).toEqual([]);
    return load(previous);
  });
  await pullCalendarFile({ ...f, output: join(f.directory, 'new', 'calendar.json'), dryRun: true });
  expect(await readdir(f.directory)).toEqual([]);
  f.load.mockImplementation(load);
  await pullCalendarFile(f);
  const original = await readFile(f.output, 'utf8');
  await pullCalendarFile({ ...f, dryRun: true });
  expect(await readdir(f.directory)).toEqual(['calendar.json']);
  expect(await readFile(f.output, 'utf8')).toBe(original);
});

it('feeds offline generation, Pages and Worker identically and preserves UIDs across repeated pulls', async () => {
  const f = await fixture();
  await pullCalendarFile(f);
  const { config } = await readCalendar(f.output);
  const schedule = join(f.directory, 'schedule.yaml');
  await writeFile(schedule, writeScheduleYaml(importFromHtml(timetable(), config, now)));
  const first = await readLocalSnapshot({ config: f.output, schedule }, undefined, now);
  await pullCalendarFile({ ...f, overwrite: true });
  const second = await readLocalSnapshot({ config: f.output, schedule }, undefined, now);
  expect(second).toEqual(first);
  expect(first.ics).toContain('UID:');
  const noNetwork = vi.fn(() => { throw new Error('unexpected network access'); });
  vi.stubGlobal('fetch', noNetwork);
  const offline = await readLocalSnapshot({ config: f.output, schedule }, undefined, now);
  const token = Buffer.alloc(32, 1).toString('base64url');
  const encoded = encodeSnapshot(offline, token);
  const decoded = decodeSnapshot(encoded.encoded, encoded.digest);
  const directory = join(f.directory, 'site');
  await preparePages({ snapshot: decoded, token, directory, baseUrl: 'https://calendar.test/', force: true, fetch: noNetwork });
  const response = await createWorker(offline).fetch(new Request(`https://calendar.test/calendar/${token}.ics`), { CALENDAR_TOKEN: token });
  expect(await response.text()).toBe(await readFile(join(directory, token, 'calendar.ics'), 'utf8'));
  expect(noNetwork).not.toHaveBeenCalled();
});

it('CLI previews a future term with field differences and unresolved holiday notices', async () => {
  const f = await fixture();
  await pullCalendarFile(f);
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(academicCalendar())));
  const argv = process.argv;
  const code = process.exitCode;
  try {
    process.argv = ['node', 'calendar-pull', '--output', f.output, '--semester', '2026-2027-2', '--dry-run'];
    await main();
    expect(errors).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/semester:.*2026-2027-2/);
    expect(logs.join('\n')).toContain('待核对：清明节、端午节放假安排另行通知。');
    expect(logs.join('\n')).toContain('预览完成，未写文件');
    expect((await readCalendar(f.output)).config.semester).toBe('2026-2027-1');
    expect(await readdir(f.directory)).toEqual(['calendar.json']);
  } finally { process.argv = argv; process.exitCode = code; }
});
