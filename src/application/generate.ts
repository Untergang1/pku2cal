import { validateConfig, type CalendarConfig } from './config.js';
import { fetchTimetable } from '../pku/elective.js';
import { parseTimetable } from '../pku/parser.js';
import { assertGenerationAllowed, assertSemesterMatches } from './semester.js';
import type { Credentials } from '../pku/auth.js';
import type { Fetch } from '../pku/http.js';
import { expandCourses } from '../schedule/expand.js';
import { serializeCalendar } from '../calendar/ics.js';

export interface GeneratedCalendar { ics: string; generatedAt: string }
export interface GenerationDependencies { fetch: Fetch; now: () => Date }

export function generateFromHtml(html: string, config: CalendarConfig, generatedAt: Date): GeneratedCalendar {
  const valid = validateConfig(config);
  assertGenerationAllowed(valid, generatedAt);
  const timetable = parseTimetable(html);
  assertSemesterMatches(valid, timetable.semester);
  return { ics: serializeCalendar(expandCourses(timetable.courses, valid), generatedAt), generatedAt: generatedAt.toISOString() };
}

export async function generateCalendar(config: unknown, credentials: Credentials, dependencies: GenerationDependencies): Promise<GeneratedCalendar> {
  const valid = validateConfig(config);
  assertGenerationAllowed(valid, dependencies.now());
  const html = await fetchTimetable(credentials, dependencies.fetch);
  return generateFromHtml(html, valid, dependencies.now());
}
