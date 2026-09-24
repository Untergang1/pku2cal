// Regression oracle for converting the already deployed data contract.
import { validateConfig, type CalendarConfig } from '../../src/migration/config.js';
import { supplementCourses } from '../../src/migration/supplements.js';
import { expandCourses as expand } from '../../src/schedule/expand.js';
import { parseTimetable, type RawCourse } from '../../src/pku/parser.js';
import { serializeCalendar } from '../../src/calendar/ics.js';
import { assertGenerationAllowed, assertSemesterMatches } from '../../src/application/semester.js';
export function expandCourses(courses: RawCourse[], config: CalendarConfig) {
  return expand(supplementCourses(courses, config, config.courseSupplements), config);
}
export function generateFromHtml(html: string, config: CalendarConfig, now: Date) {
  const valid = validateConfig(config);
  assertGenerationAllowed(valid, now);
  const parsed = parseTimetable(html);
  assertSemesterMatches(valid, parsed.semester);
  return { ics: serializeCalendar(expandCourses(parsed.courses, valid), now), generatedAt: now.toISOString() };
}
