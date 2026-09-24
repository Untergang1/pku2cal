// Test adapters keep the existing raw-page regression cases at the new import boundary.
import { importCourses, importFromHtml } from '../../src/application/import.js';
import { generateCalendar } from '../../src/application/generate.js';
import { resolveSchedule } from '../../src/schedule/document.js';
import { expandCourses as expand } from '../../src/schedule/expand.js';
import type { RawCourse } from '../../src/pku/parser.js';
import type { CalendarConfig } from '../../src/application/config.js';
export function expandCourses(courses: RawCourse[], config: CalendarConfig) {
  return expand(resolveSchedule(importCourses(courses, config, new Date('2026-09-24T00:00:00Z')), config), config);
}
export function generateFromHtml(html: string, config: CalendarConfig, now: Date) {
  return generateCalendar(importFromHtml(html, config, now), config, now);
}
