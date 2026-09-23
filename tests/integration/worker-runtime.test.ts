import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { workerRuntime } from './runtime.js';
import { config, timetable } from '../fixtures/timetable.js';
import { generateFromHtml } from '../../src/application/generate.js';
import { cacheIdentity } from '../../src/entrypoints/worker.js';
import type { CalendarStore } from '../../src/entrypoints/worker.js';

it('runs the complete generation pipeline with workerd and a real local KV binding', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const token = 't'.repeat(43);
  const runtime = await workerRuntime('tests/fixtures/calendar-worker.ts', {
    PKU_USERNAME: { type: 'text', value: 'synthetic' }, PKU_PASSWORD: { type: 'text', value: 'synthetic-password' },
    CALENDAR_TOKEN: { type: 'text', value: token }, TEST_PUBLIC_KEY: { type: 'text', value: pem },
    CALENDAR_KV: { type: 'kv', id: 'synthetic' },
  });
  try {
    const response = await runtime.dispatchFetch(`http://localhost/calendar/${token}.ics`);
    expect(response.status).toBe(200);
    const expected = generateFromHtml(timetable(), config, new Date('2026-09-01T00:00:00Z'));
    expect(await response.text()).toBe(expected.ics);
    const { CALENDAR_KV: kv } = await runtime.getBindings<{ CALENDAR_KV: CalendarStore & { list(): Promise<{ keys: { name: string; expiration?: number }[] }> } }>();
    const saved = JSON.parse((await kv.get(cacheIdentity(config, 'synthetic').key))!);
    expect(saved.ics).toBe(expected.ics);
    expect((await kv.list()).keys[0]).not.toHaveProperty('expiration');
    expect(await (await runtime.dispatchFetch(`http://localhost/calendar/${token}.ics`)).text()).toBe(expected.ics);
    expect((await runtime.dispatchFetch('http://localhost/calendar/wrong.ics')).status).toBe(404);
  } finally { await runtime.dispose(); }
});
