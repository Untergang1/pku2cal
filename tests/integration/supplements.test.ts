import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { configWithPrivateSupplements } from '../../src/application/config.js';
import { generateCalendar, generateFromHtml } from '../../src/application/generate.js';
import { generateFile } from '../../src/entrypoints/node.js';
import { readPrivateSupplements } from '../../src/entrypoints/private-supplements.js';
import { preparePages } from '../../src/entrypoints/pages-prepare.js';
import { cacheIdentity, createWorker, REFRESH_MS, type CalendarStore } from '../../src/entrypoints/worker.js';
import { config, course, timetable } from '../fixtures/timetable.js';
import { supplements } from '../fixtures/supplements.js';
import { upstream } from '../fixtures/upstream.js';

const directory = await mkdtemp(join(tmpdir(), 'pku-supplements-'));
afterAll(() => rm(directory, { recursive: true, force: true }));
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
const now = new Date('2026-09-24T00:00:00Z');
const credentials = { username: 'synthetic', password: 'synthetic-password' };
const effective = configWithPrivateSupplements(config, JSON.stringify(supplements));
const dependencies = () => ({ fetch: upstream(pem, timetable()), now: () => now });
const token = Buffer.alloc(32, 1).toString('base64url');
const request = () => new Request(`https://calendar.test/calendar/${token}.ics`);

class Store implements CalendarStore {
  data = new Map<string, string>();
  get = vi.fn(async (key: string) => this.data.get(key) ?? null);
  put = vi.fn(async (key: string, value: string) => { this.data.set(key, value); });
}
const env = (store: CalendarStore, json = JSON.stringify(supplements)) => ({
  PKU_USERNAME: credentials.username, PKU_PASSWORD: credentials.password,
  CALENDAR_TOKEN: token, CALENDAR_KV: store, PKU_COURSE_SUPPLEMENTS: json,
});

it('reads private files, rejects competing sources and sanitizes filesystem failures', async () => {
  const file = join(directory, 'supplements.json');
  const json = JSON.stringify(supplements);
  await writeFile(file, json);
  expect(await readPrivateSupplements(undefined, file)).toBe(json);
  expect(await readPrivateSupplements(json, undefined)).toBe(json);
  expect(await readPrivateSupplements('  ', undefined)).toBe('  ');
  await expect(readPrivateSupplements(undefined, file, async () => '  ')).rejects.toThrow('supplements:invalid');
  await expect(readPrivateSupplements('null', file)).rejects.toThrow('supplements:invalid');
  await expect(readPrivateSupplements(undefined, join(directory, 'private-missing'))).rejects.toThrow('supplements:invalid');
});

it('produces identical Node files, Pages artifacts and Worker responses with supplements', async () => {
  const file = join(directory, 'calendar.ics');
  const node = await generateFile({ config: effective, output: file, credentials, dependencies: dependencies() });
  const site = join(directory, 'site');
  const decision = await preparePages({ token, baseUrl: 'https://calendar.test', force: false, directory: site,
    generate: () => generateCalendar(effective, credentials, dependencies()),
    fetch: async () => new Response('', { status: 404 }), assertAllowed: () => {} });
  expect(decision.changed).toBe(true);
  expect(await readFile(join(site, token, 'calendar.ics'), 'utf8')).toBe(node.ics);
  expect(await readFile(file, 'utf8')).toBe(node.ics);
  const worker = createWorker(config, { ...dependencies(), log: () => {} });
  expect(await (await worker.fetch(request(), env(new Store()))).text()).toBe(node.ics);
});

it.each(['conflict', 'upstream'])('preserves Node and Pages output on %s failure', async kind => {
  const file = join(directory, `${kind}.ics`);
  const site = join(directory, `site-${kind}`);
  await writeFile(file, 'old calendar');
  const html = kind === 'conflict' ? timetable([{ course: { ...course, courseId: supplements.courses[0]!.courseId } }]) : 'broken upstream';
  const generate = () => generateCalendar(effective, credentials, { fetch: upstream(pem, html), now: () => now });
  await preparePages({ token, baseUrl: 'https://calendar.test', force: true, directory: site,
    generate: async () => generateFromHtml(timetable(), effective, now), fetch: vi.fn(), assertAllowed: () => {} });
  const before = await readFile(join(site, token, 'calendar.ics'), 'utf8');
  await expect(generateFile({ config: effective, output: file, credentials, dependencies: { fetch: upstream(pem, html), now: () => now } })).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('old calendar');
  const fetch = vi.fn();
  await expect(preparePages({ token, baseUrl: 'https://calendar.test', force: false, directory: site,
    generate, fetch, assertAllowed: () => {} })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(join(site, token, 'calendar.ics'), 'utf8')).toBe(before);
});

it('serves only same-config stale data on conflicts; changed supplements cannot read the old snapshot', async () => {
  const store = new Store();
  const generated = generateFromHtml(timetable(), effective, now);
  const identity = cacheIdentity(effective, credentials.username);
  store.data.set(identity.key, JSON.stringify({ ...generated, fingerprint: identity.fingerprint }));
  const logs = vi.fn();
  const conflict = timetable([{ course: { ...course, courseId: supplements.courses[0]!.courseId } }]);
  const worker = createWorker(config, { now: () => new Date(now.getTime() + REFRESH_MS), fetch: upstream(pem, conflict), log: logs });
  const stale = await worker.fetch(request(), env(store));
  expect(stale.headers.get('x-calendar-status')).toBe('stale');
  expect(await stale.text()).toBe(generated.ics);
  expect(logs.mock.calls[0]?.[0].category).toBe('supplements:conflict');
  const changed = JSON.stringify({ ...supplements, locations: supplements.locations.map(l => ({ ...l, location: '新教室' })) });
  expect((await worker.fetch(request(), env(store, changed))).status).toBe(503);
  expect(store.put).not.toHaveBeenCalled();
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/SYN003|合成|新教室/);
});

it('rejects malformed supplements before reading cache or upstream', async () => {
  const store = new Store();
  const fetch = vi.fn();
  const log = vi.fn();
  const worker = createWorker(config, { fetch, now: () => now, log });
  expect((await worker.fetch(request(), env(store, '{invalid-private-json'))).status).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
  expect(store.get).not.toHaveBeenCalled();
  expect(log.mock.calls[0]?.[0].category).toBe('supplements:invalid');
});
