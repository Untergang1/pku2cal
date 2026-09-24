import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorker } from '../../src/entrypoints/worker.js';
import { generateFile } from '../../src/entrypoints/node.js';
import { pullFile } from '../../src/entrypoints/schedule-pull.js';
import { importFromHtml } from '../../src/application/import.js';
import { generateCalendar } from '../../src/application/generate.js';
import { readScheduleYaml } from '../../src/schedule/document.js';
import { config, timetable } from '../fixtures/timetable.js';

const now = new Date('2026-09-24T00:00:00Z');
const document = importFromHtml(timetable(), config, now);
const token = Buffer.alloc(32, 1).toString('base64url');
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pku-local-')); directories.push(directory);
  return { output: join(directory, 'schedule.yaml'), backups: join(directory, 'backups'), overwrite: false,
    load: vi.fn(async () => document), assertAllowed: vi.fn(), directory };
}
it('creates a private YAML file and refuses overwrite before fetching', async () => {
  const f = await fixture();
  await pullFile(f);
  expect(readScheduleYaml(await readFile(f.output, 'utf8'))).toEqual(document);
  expect((await stat(f.output)).mode & 0o777).toBe(0o600);
  await expect(pullFile(f)).rejects.toThrow('--overwrite');
  expect(f.load).toHaveBeenCalledTimes(1);
  expect(await readdir(f.directory)).toEqual(['schedule.yaml']);
});
it('backs up the exact original bytes, including broken drafts, before explicit replacement', async () => {
  const f = await fixture();
  const original = '# personal comment\ninvalid draft [';
  await writeFile(f.output, original);
  await pullFile({ ...f, overwrite: true });
  const backups = await readdir(f.backups);
  expect(backups).toHaveLength(1);
  expect(await readFile(join(f.backups, backups[0]!), 'utf8')).toBe(original);
});
it.each(['upstream', 'edited', 'expired', 'backup'])('preserves old YAML when %s fails', async kind => {
  const f = await fixture();
  await writeFile(f.output, 'original');
  if (kind === 'upstream') f.load.mockRejectedValue(new Error('upstream'));
  if (kind === 'edited') f.load.mockImplementation(async () => { await writeFile(f.output, 'edited'); return document; });
  if (kind === 'expired') f.assertAllowed.mockImplementation(() => { throw new Error('expired'); });
  if (kind === 'backup') await writeFile(f.backups, 'blocks directory creation');
  await expect(pullFile({ ...f, overwrite: true })).rejects.toThrow();
  expect(await readFile(f.output, 'utf8')).toBe(kind === 'edited' ? 'edited' : 'original');
  expect((await readdir(f.directory)).some(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
});
it('refuses concurrent pulls and a file created during an initial pull', async () => {
  const f = await fixture();
  f.load.mockImplementation(async () => {
    await expect(pullFile(f)).rejects.toThrow('操作锁');
    await writeFile(f.output, 'created by editor');
    return document;
  });
  await expect(pullFile(f)).rejects.toThrow('被修改');
  expect(await readFile(f.output, 'utf8')).toBe('created by editor');
});
it('generates offline after semester expiry and serves identical immutable bytes without any network access', async () => {
  const f = await fixture();
  const network = vi.fn(() => { throw new Error('must not access network'); });
  vi.stubGlobal('fetch', network);
  const bound = { ...config, semesterBinding: { confirmedSemester: config.semester, validFrom: '2026-09-01', validThrough: '2026-09-30' } };
  const output = join(f.directory, 'calendar.ics');
  const snapshot = await generateFile({ document, config: bound, output, now: new Date('2030-01-01') });
  const worker = createWorker(snapshot);
  const request = (value = token, method = 'GET') => new Request(`https://calendar.test/calendar/${value}.ics`, { method });
  const env = { CALENDAR_TOKEN: token };
  expect((await worker.fetch(request('wrong'), env)).status).toBe(404);
  expect((await worker.fetch(request(token, 'POST'), env)).status).toBe(405);
  const response = await worker.fetch(request(), env);
  expect(await response.text()).toBe(await readFile(output, 'utf8'));
  expect(response.headers.get('x-calendar-status')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(network).not.toHaveBeenCalled();
  await expect(generateFile({ document: { ...document, semester: '2025-2026-1' }, config, output, now })).rejects.toThrow();
  expect(await readFile(output, 'utf8')).toBe(snapshot.ics);
});
it('returns 503 for missing deployment token or malformed snapshot', async () => {
  const request = new Request(`https://calendar.test/calendar/${token}.ics`);
  expect((await createWorker(generateCalendar(document, config, now)).fetch(request, {})).status).toBe(503);
  expect((await createWorker({ ics: 'bad', generatedAt: 'bad' }).fetch(request, { CALENDAR_TOKEN: token })).status).toBe(503);
});
