import { validateConfig } from './config.js';
import { resolveSchedule } from '../schedule/document.js';
import { expandCourses } from '../schedule/expand.js';
import { serializeCalendar } from '../calendar/ics.js';

export interface GeneratedCalendar { ics: string; generatedAt: string }

/** Offline generation: neither credentials nor an upstream fetch dependency. */
export function generateCalendar(document: unknown, config: unknown, generatedAt: Date): GeneratedCalendar {
  const valid = validateConfig(config);
  return { ics: serializeCalendar(expandCourses(resolveSchedule(document, valid), valid), generatedAt), generatedAt: generatedAt.toISOString() };
}
