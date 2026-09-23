import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createWorker, cacheIdentity, REFRESH_MS, type CalendarStore, type WorkerEnv } from '../../src/entrypoints/worker.js';
import { generateFile } from '../../src/entrypoints/node.js';
import { generateFromHtml } from '../../src/application/generate.js';
import { config, timetable } from '../fixtures/timetable.js';
import { upstream } from '../fixtures/upstream.js';

class Store implements CalendarStore {
  data = new Map<string, string>();
  get = vi.fn(async (key: string) => this.data.get(key) ?? null);
  put = vi.fn(async (key: string, value: string) => { this.data.set(key, value); });
}
const now = new Date('2026-09-01T00:00:00Z');
const token = 'a'.repeat(43);
const request = (secret = token) => new Request(`https://calendar.test/calendar/${secret}.ics`);
const env = (store: CalendarStore): WorkerEnv => ({ PKU_USERNAME: 'synthetic', PKU_PASSWORD: 'synthetic-password', CALENDAR_TOKEN: token, CALENDAR_KV: store });
const output = generateFromHtml(timetable(), config, now);
const silence = () => {};

describe('Worker HTTP and cache behavior', () => {
  it('checks token and method before KV or upstream access', async () => {
    const store = new Store();
    const generate = vi.fn(async () => output);
    const worker = createWorker(config, { generate, now: () => now, log: silence });
    expect((await worker.fetch(request('wrong'), env(store))).status).toBe(404);
    expect((await worker.fetch(new Request(request().url, { method: 'POST' }), env(store))).status).toBe(405);
    expect(store.get).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
  it('stores a complete snapshot and reuses it until exactly six hours', async () => {
    const store = new Store();
    let clock = now;
    const generate = vi.fn(async () => ({ ...output, generatedAt: clock.toISOString() }));
    const worker = createWorker(config, { generate, now: () => clock, log: silence });
    const a = await worker.fetch(request(), env(store));
    expect(a.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(a.headers.get('cache-control')).toBe('private, no-store');
    expect(await a.text()).toBe(output.ics);
    expect(store.put).toHaveBeenCalledTimes(1);
    clock = new Date(now.getTime() + REFRESH_MS - 1);
    await worker.fetch(request(), env(store));
    expect(generate).toHaveBeenCalledTimes(1);
    clock = new Date(now.getTime() + REFRESH_MS);
    await worker.fetch(request(), env(store));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledTimes(2);
  });
  it('keeps arbitrarily old same-config snapshots on refresh failure', async () => {
    const store = new Store();
    const { key, fingerprint } = cacheIdentity(config, 'synthetic');
    store.data.set(key, JSON.stringify({ ...output, fingerprint }));
    const before = store.data.get(key);
    const worker = createWorker(config, { now: () => new Date(now.getTime() + 90 * 86400000), generate: async () => { throw new Error('secret upstream response'); }, log: silence });
    const response = await worker.fetch(request(), env(store));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-calendar-status')).toBe('stale');
    expect(response.headers.get('last-modified')).toBe(now.toUTCString());
    expect(await response.text()).toBe(output.ics);
    expect(store.data.get(key)).toBe(before);
    expect(store.put).not.toHaveBeenCalled();
  });
  it('never substitutes an empty calendar for an upstream failure', async () => {
    const log = vi.fn();
    const worker = createWorker(config, { generate: async () => { throw new Error('sensitive password and HTML'); }, now: () => now, log });
    const response = await worker.fetch(request(), env(new Store()));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('VCALENDAR');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/password|HTML/);
  });
  it('isolates accounts and configuration, but not token rotations', async () => {
    const store = new Store();
    const generate = vi.fn(async () => output);
    const worker = createWorker(config, { generate, now: () => now, log: silence });
    await worker.fetch(request(), env(store));
    const rotated = 'b'.repeat(43);
    expect((await worker.fetch(request(), { ...env(store), CALENDAR_TOKEN: rotated })).status).toBe(404);
    await worker.fetch(request(rotated), { ...env(store), CALENDAR_TOKEN: rotated });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(cacheIdentity(config, 'someone-else').key).not.toBe(cacheIdentity(config, 'synthetic').key);
    const changed = createWorker({ ...config, holidays: ['2026-09-07'] }, { generate: async () => { throw new Error(); }, now: () => now, log: silence });
    expect((await changed.fetch(request(), env(store))).status).toBe(503);
  });
  it('canonicalizes equivalent config orderings', () => {
    const first = { ...config, holidays: ['2026-09-07', '2026-09-14'] };
    expect(cacheIdentity(first, 'synthetic')).toEqual(cacheIdentity({ ...first, periods: [...config.periods].reverse(), holidays: [...first.holidays].reverse() }, 'synthetic'));
  });
  it('coalesces concurrent refreshes and permits retry after a failure', async () => {
    const store = new Store();
    let finish!: (value: typeof output) => void;
    const generate = vi.fn(() => new Promise<typeof output>(resolve => { finish = resolve; }));
    const worker = createWorker(config, { generate, now: () => now, log: silence });
    const responses = [worker.fetch(request(), env(store)), worker.fetch(request(), env(store))];
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    finish(output);
    expect((await Promise.all(responses)).every(r => r.status === 200)).toBe(true);
    expect(store.put).toHaveBeenCalledTimes(1);
    const flaky = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue(output);
    const retry = createWorker(config, { generate: flaky, now: () => now, log: silence });
    const fresh = env(new Store());
    expect((await retry.fetch(request(), fresh)).status).toBe(503);
    expect((await retry.fetch(request(), fresh)).status).toBe(200);
  });
  it('does not overwrite an existing copy if KV writes fail', async () => {
    const store = new Store();
    const { key, fingerprint } = cacheIdentity(config, 'synthetic');
    store.data.set(key, JSON.stringify({ ...output, fingerprint }));
    store.put.mockRejectedValue(new Error('KV unavailable'));
    const worker = createWorker(config, { generate: async () => output, now: () => new Date(now.getTime() + REFRESH_MS), log: silence });
    expect((await worker.fetch(request(), env(store))).headers.get('x-calendar-status')).toBe('stale');
  });
  it('ignores corrupt or future snapshots', async () => {
    const store = new Store();
    const { key, fingerprint } = cacheIdentity(config, 'synthetic');
    const generate = vi.fn(async () => output);
    const worker = createWorker(config, { generate, now: () => now, log: silence });
    for (const value of ['broken json', JSON.stringify({ ...output, fingerprint, generatedAt: '2030-01-01' })]) {
      store.data.set(key, value);
      await worker.fetch(request(), env(store));
    }
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

const directories: string[] = [];
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
it('produces identical bytes through Node file output and Worker generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pku2cal-test-')); directories.push(directory);
  const path = join(directory, 'calendar.ics');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fetch = upstream(pem, timetable());
  const credentials = { username: 'synthetic', password: 'synthetic-password' };
  await generateFile({ config, output: path, credentials, dependencies: { fetch, now: () => now } });
  const worker = createWorker(config, { fetch, now: () => now, log: silence });
  expect(await (await worker.fetch(request(), env(new Store()))).text()).toBe(await readFile(path, 'utf8'));
  expect(await readdir(directory)).toEqual(['calendar.ics']);
  await writeFile(path, 'existing successful calendar');
  await expect(generateFile({ config, output: path, credentials, dependencies: { fetch: upstream(pem, '<html>maintenance</html>'), now: () => now } })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('existing successful calendar');
  expect(await readdir(directory)).toEqual(['calendar.ics']);
});
