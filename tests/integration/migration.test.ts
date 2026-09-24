import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { migrateSchedule, readMigrationConfig } from '../../src/migration/import.js';
import { configWithPrivateConfirmations, configWithPrivateSupplements } from '../../src/migration/config.js';
import { generateCalendar } from '../../src/application/generate.js';
import { generateFromHtml as legacyCalendar } from '../fixtures/legacy.js';
import { config, course, timetable } from '../fixtures/timetable.js';
import { supplements } from '../fixtures/supplements.js';
import { upstream } from '../fixtures/upstream.js';

const now = new Date('2026-09-24T00:00:00Z');
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
const credentials = { username: 'synthetic', password: 'synthetic' };
const unscheduled = { ...course, courseId: 'SYN002', segments: ['(合成无固定时间说明)'] };
const decision = { semester: config.semester, courseId: unscheduled.courseId, classId: unscheduled.classId, confirmed: true, expectedSegments: unscheduled.segments };
const effective = configWithPrivateSupplements(configWithPrivateConfirmations(config, JSON.stringify([decision])), JSON.stringify(supplements));
it('migrates confirmed omissions, locations and added courses without changing existing calendar bytes or UIDs', async () => {
  const html = timetable([{ course }, { course: unscheduled }]);
  const document = await migrateSchedule(effective, credentials, { fetch: upstream(pem, html), now: () => now });
  const migrated = generateCalendar(document, config, now);
  expect(migrated).toEqual(legacyCalendar(html, effective, now));
  expect(document.courses.find(c => c.courseId === 'SYN002')!.slots).toEqual([
    { status: 'ignored', sourceText: unscheduled.segments[0], reason: '从原人工确认列表迁移：无固定上课时间' },
  ]);
});
it.each(['changed', 'conflict', 'semester', 'malformed'])('refuses migration on %s without guessing', async kind => {
  const html = kind === 'malformed' ? '<html>maintenance</html>' : timetable([
    { course }, { course: { ...unscheduled, segments: kind === 'changed' ? ['新说明'] : unscheduled.segments } },
    ...(kind === 'conflict' ? [{ course: { ...course, courseId: supplements.courses[0]!.courseId } }] : []),
  ], kind === 'semester' ? '2025-2026学年第一学期' : '2026-2027学年第一学期');
  await expect(migrateSchedule(effective, credentials, { fetch: upstream(pem, html), now: () => now })).rejects.toThrow();
});
it('reads legacy private files only through the explicit migration adapter and rejects competing sources', async () => {
  const { periods, ...fields } = config;
  const read = vi.fn(async (path: string) => {
    if (path === 'calendar.json') return JSON.stringify({ ...fields, timetable: 'pku-main' });
    if (path.endsWith('pku-main.json')) return JSON.stringify({ label: 'Synthetic', periods });
    if (path === 'confirmations.json') return JSON.stringify([decision]);
    throw new Error('missing');
  });
  expect((await readMigrationConfig('calendar.json', { PKU_UNSCHEDULED_COURSES_FILE: 'confirmations.json' }, read)).config.unscheduledCourses).toEqual([decision]);
  await expect(readMigrationConfig('calendar.json', { PKU_UNSCHEDULED_COURSES_FILE: 'confirmations.json', PKU_UNSCHEDULED_COURSES: '[]' }, read)).rejects.toThrow('conflicting_sources');
});
