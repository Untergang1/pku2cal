import { fileURLToPath } from 'node:url';
import { fetchTimetable } from '../pku/elective.js';
import { parseTimetable } from '../pku/parser.js';
import type { Credentials } from '../pku/auth.js';
import { editableSlot, type ImportDependencies } from '../application/import.js';
import { assertGenerationAllowed, assertSemesterMatches } from '../application/semester.js';
import { resolveCalendarConfig } from '../entrypoints/calendar-config.js';
import { configWithPrivateConfirmations, configWithPrivateSupplements, validateSourceConfig } from './config.js';
import { supplementCourses } from './supplements.js';
import { isConfirmedUnscheduled } from './unscheduled.js';
import { resolveSchedule, type ScheduleDocument } from '../schedule/document.js';
import { readPrivateSupplements } from './private-supplements.js';
import { readText, type ReadFile } from '../entrypoints/local-data.js';

export async function readMigrationConfig(path: string, env: NodeJS.ProcessEnv, read: ReadFile = readText) {
  const source = validateSourceConfig(JSON.parse(await read(path)));
  const { unscheduledCourses, ...publicSource } = source;
  const selected = await resolveCalendarConfig(publicSource, file => read(fileURLToPath(file)));
  const inline = env.PKU_UNSCHEDULED_COURSES;
  const file = env.PKU_UNSCHEDULED_COURSES_FILE;
  if (file?.trim() && inline?.trim()) throw new Error('migration:conflicting_sources');
  const confirmations = file?.trim() ? await read(file) : inline;
  const supplements = await readPrivateSupplements(env.PKU_COURSE_SUPPLEMENTS, env.PKU_COURSE_SUPPLEMENTS_FILE, read);
  const config = configWithPrivateSupplements(configWithPrivateConfirmations({ ...selected.config,
    ...(unscheduledCourses === undefined ? {} : { unscheduledCourses }) }, confirmations), supplements);
  return { config, publicConfig: selected.config };
}
export async function migrateSchedule(config: Awaited<ReturnType<typeof readMigrationConfig>>['config'], credentials: Credentials, dependencies: ImportDependencies): Promise<ScheduleDocument> {
  assertGenerationAllowed(config, dependencies.now());
  const parsed = parseTimetable(await fetchTimetable(credentials, dependencies.fetch));
  assertGenerationAllowed(config, dependencies.now());
  assertSemesterMatches(config, parsed.semester);
  const scheduled = supplementCourses(parsed.courses, config, config.courseSupplements);
  const document: ScheduleDocument = { version: 1, semester: config.semester, importedAt: dependencies.now().toISOString(),
    courses: scheduled.map(course => ({ ...course, slots: course.slots.map(editableSlot) })) };
  for (const course of parsed.courses) {
    if (isConfirmedUnscheduled(course, config.unscheduledCourses ?? [])) {
      const { segments, ...info } = course;
      document.courses.push({ ...info, slots: segments.map(sourceText => ({ status: 'ignored', sourceText, reason: '从原人工确认列表迁移：无固定上课时间' })) });
    }
  }
  const { unscheduledCourses: _confirmations, courseSupplements: _supplements, ...publicConfig } = config;
  resolveSchedule(document, publicConfig);
  return document;
}
