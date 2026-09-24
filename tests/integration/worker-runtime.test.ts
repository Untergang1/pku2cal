import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { workerRuntime } from './runtime.js';
import { config, timetable } from '../fixtures/timetable.js';
import { generateFromHtml } from '../../src/application/generate.js';
import { cacheIdentity } from '../../src/entrypoints/worker.js';
import type { CalendarStore } from '../../src/entrypoints/worker.js';
import { configWithPrivateConfirmations } from '../../src/application/config.js';

it.each([false, true])('runs the complete pipeline with workerd and KV (manual confirmation: %s)', async manual => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const token = 't'.repeat(43);
  const chosenConfig = manual ? { ...config, semesterBinding: { confirmedSemester: config.semester, validFrom: '2026-09-01', validThrough: '2026-09-30' } } : config;
  const untimed = { courseId: 'SYN002', classId: '01', name: '合成无固定时间课程', teacher: '', segments: ['(无固定时间说明)'] };
  const confirmations = manual ? JSON.stringify([{ semester: config.semester, courseId: untimed.courseId, classId: untimed.classId, confirmed: true, expectedSegments: untimed.segments }]) : '';
  const html = manual ? timetable([{}, { course: untimed }], '学期课程表') : timetable();
  const effective = configWithPrivateConfirmations(chosenConfig, confirmations);
  const runtime = await workerRuntime('tests/fixtures/calendar-worker.ts', {
    PKU_USERNAME: { type: 'text', value: 'synthetic' }, PKU_PASSWORD: { type: 'text', value: 'synthetic-password' },
    CALENDAR_TOKEN: { type: 'text', value: token }, TEST_PUBLIC_KEY: { type: 'text', value: pem },
    CALENDAR_KV: { type: 'kv', id: 'synthetic' },
    TEST_CONFIG: { type: 'text', value: JSON.stringify(chosenConfig) }, TEST_HTML: { type: 'text', value: html },
    PKU_UNSCHEDULED_COURSES: { type: 'text', value: confirmations },
  });
  try {
    const response = await runtime.dispatchFetch(`http://localhost/calendar/${token}.ics`);
    expect(response.status).toBe(200);
    const expected = generateFromHtml(html, effective, new Date('2026-09-01T00:00:00Z'));
    expect(await response.text()).toBe(expected.ics);
    const { CALENDAR_KV: kv } = await runtime.getBindings<{ CALENDAR_KV: CalendarStore & { list(): Promise<{ keys: { name: string; expiration?: number }[] }> } }>();
    const saved = JSON.parse((await kv.get(cacheIdentity(effective, 'synthetic').key))!);
    expect(saved.ics).toBe(expected.ics);
    expect((await kv.list()).keys[0]).not.toHaveProperty('expiration');
    expect(await (await runtime.dispatchFetch(`http://localhost/calendar/${token}.ics`)).text()).toBe(expected.ics);
    expect((await runtime.dispatchFetch('http://localhost/calendar/wrong.ics')).status).toBe(404);
  } finally { await runtime.dispose(); }
});
