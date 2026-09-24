import { validateConfig, type CalendarConfig } from './config.js';
import { assertGenerationAllowed, assertSemesterMatches } from './semester.js';
import { fetchTimetable } from '../pku/elective.js';
import { parseTimetable, type RawCourse } from '../pku/parser.js';
import type { Credentials } from '../pku/auth.js';
import type { Fetch } from '../pku/http.js';
import { parseTime, type Slot } from '../schedule/time.js';
import { resolveSchedule, type DocumentSlot, type ScheduleDocument } from '../schedule/document.js';

export interface ImportDependencies { fetch: Fetch; now: () => Date }
export function editableSlot(slot: Slot): DocumentSlot {
  const runs: string[] = [];
  const weeks = [...slot.weeks].sort((a, b) => a - b);
  for (let i = 0; i < weeks.length; i++) {
    const start = weeks[i]!;
    let end = start;
    while (weeks[i + 1] === end + 1) end = weeks[++i]!;
    runs.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return { status: 'scheduled', weekday: slot.weekday, startPeriod: slot.startPeriod, endPeriod: slot.endPeriod,
    weeks: runs.join(','), parity: 'all', location: slot.location };
}
export function importCourses(courses: RawCourse[], config: CalendarConfig, importedAt: Date): ScheduleDocument {
  const document: ScheduleDocument = { version: 1, semester: config.semester, importedAt: importedAt.toISOString(),
    courses: courses.map(({ segments, ...course }) => ({ ...course, slots: segments.map(sourceText => {
      try { return editableSlot(parseTime(sourceText, config.teachingWeeks)); }
      catch { return { status: 'pending' as const, sourceText }; }
    }) })) };
  resolveSchedule(document, config, true);
  return document;
}
export function importFromHtml(html: string, config: CalendarConfig, now: Date): ScheduleDocument {
  const valid = validateConfig(config);
  assertGenerationAllowed(valid, now);
  const parsed = parseTimetable(html);
  assertSemesterMatches(valid, parsed.semester);
  return importCourses(parsed.courses, valid, now);
}
export async function importSchedule(config: unknown, credentials: Credentials, dependencies: ImportDependencies): Promise<ScheduleDocument> {
  const valid = validateConfig(config);
  assertGenerationAllowed(valid, dependencies.now());
  return importFromHtml(await fetchTimetable(credentials, dependencies.fetch), valid, dependencies.now());
}
