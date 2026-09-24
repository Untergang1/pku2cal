import { expect, it } from 'vitest';
import { workerRuntime } from './runtime.js';
import { generateCalendar } from '../../src/application/generate.js';
import { importFromHtml } from '../../src/application/import.js';
import { config, timetable } from '../fixtures/timetable.js';

it('serves the embedded deployment snapshot in workerd without KV or PKU secrets', async () => {
  const now = new Date('2026-09-24T00:00:00Z');
  const snapshot = generateCalendar(importFromHtml(timetable(), config, now), config, now);
  const token = Buffer.alloc(32, 1).toString('base64url');
  const mf = await workerRuntime('src/entrypoints/worker-deploy.ts', { CALENDAR_TOKEN: { type: 'text', value: token } }, { __CALENDAR_SNAPSHOT__: JSON.stringify(snapshot) });
  try {
    const response = await mf.dispatchFetch(`http://localhost/calendar/${token}.ics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(snapshot.ics);
    expect(response.headers.get('last-modified')).toBe(now.toUTCString());
    expect((await mf.dispatchFetch('http://localhost/calendar/wrong.ics')).status).toBe(404);
  } finally { await mf.dispose(); }
});
