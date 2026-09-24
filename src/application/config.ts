import { z } from 'zod';
import { addDays, dateEpoch } from '../schedule/time.js';

const date = z.string().refine(value => { try { dateEpoch(value); return true; } catch { return false; } });
const text = z.string().trim().min(1);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const semester = z.string().regex(/^20\d{2}-20\d{2}-[123]$/);
const schema = z.strictObject({
  namespace: text,
  semester,
  semesterBinding: z.strictObject({
    confirmedSemester: semester,
    validFrom: date,
    validThrough: date,
  }).optional(),
  unscheduledCourses: z.array(z.strictObject({
    semester,
    courseId: text,
    classId: text,
    confirmed: z.literal(true),
    expectedSegments: z.array(text).min(1),
  })).optional(),
  firstMonday: date,
  teachingWeeks: z.number().int().min(1).max(53),
  periods: z.array(z.strictObject({ period: z.number().int().min(1).max(30), start: clock, end: clock })).min(1),
  holidays: z.array(date),
  makeups: z.record(date, date),
});
export type CalendarConfig = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor() { super('configuration:invalid'); this.name = 'ConfigError'; }
}

/** Returns a canonical configuration, also used as the cache fingerprint input. */
export function validateConfig(input: unknown): CalendarConfig {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConfigError();
  const c = result.data;
  if (new Date(dateEpoch(c.firstMonday)).getUTCDay() !== 1) throw new ConfigError();
  const [year, next] = c.semester.split('-').map(Number);
  if (next !== year! + 1) throw new ConfigError();
  if (c.semesterBinding && (c.semesterBinding.confirmedSemester !== c.semester || c.semesterBinding.validFrom > c.semesterBinding.validThrough)) throw new ConfigError();
  if (c.unscheduledCourses) {
    const identities = c.unscheduledCourses.map(course => JSON.stringify([course.courseId, course.classId]));
    if (new Set(identities).size !== identities.length || c.unscheduledCourses.some(course => course.semester !== c.semester)) throw new ConfigError();
    c.unscheduledCourses.sort((a, b) => a.courseId.localeCompare(b.courseId) || a.classId.localeCompare(b.classId));
  }
  c.periods.sort((a, b) => a.period - b.period);
  for (let i = 0; i < c.periods.length; i++) {
    const p = c.periods[i]!;
    if (p.start >= p.end || (i > 0 && (c.periods[i - 1]!.period === p.period || c.periods[i - 1]!.end > p.start))) throw new ConfigError();
  }
  if (new Set(c.holidays).size !== c.holidays.length) throw new ConfigError();
  c.holidays.sort();
  const sources = Object.values(c.makeups);
  const targets = Object.keys(c.makeups);
  const lastDay = addDays(c.firstMonday, c.teachingWeeks * 7 - 1);
  if (new Set(sources).size !== sources.length || sources.some(source => source < c.firstMonday || source > lastDay || targets.includes(source)) || targets.some(target => c.holidays.includes(target))) throw new ConfigError();
  c.makeups = Object.fromEntries(Object.entries(c.makeups).sort(([a], [b]) => a.localeCompare(b)));
  return c;
}

/** Entrypoints may supply private decisions without putting them in public config. */
export function configWithPrivateConfirmations(input: unknown, json: string | undefined): CalendarConfig {
  const config = validateConfig(input);
  if (json === undefined || json.trim() === '') return config;
  // Reject two competing sources instead of silently overriding a confirmation.
  if (config.unscheduledCourses !== undefined) throw new ConfigError();
  let decisions: unknown;
  try { decisions = JSON.parse(json); } catch { throw new ConfigError(); }
  return validateConfig({ ...config, unscheduledCourses: decisions });
}
