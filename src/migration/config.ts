import { z } from 'zod';
import { courseSupplementsSchema, SupplementError, validateCourseSupplements } from './supplements.js';
import { addDays, dateEpoch } from '../schedule/time.js';

const date = z.string().refine(value => { try { dateEpoch(value); return true; } catch { return false; } });
const text = z.string().trim().min(1);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const semester = z.string().regex(/^20\d{2}-20\d{2}-[123]$/);
const calendarFields = z.strictObject({
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
  holidays: z.array(date),
  makeups: z.record(date, date),
});
const periods = z.array(z.strictObject({ period: z.number().int().min(1).max(30), start: clock, end: clock })).min(1);
// Keep canonical field order stable: Worker fingerprints include serialized config.
const schema = calendarFields.omit({ holidays: true, makeups: true }).extend({
  courseSupplements: courseSupplementsSchema.optional(),
  periods, holidays: calendarFields.shape.holidays, makeups: calendarFields.shape.makeups,
});
const timetableId = z.enum(['pku-main', 'pku-ss']);
const sourceSchema = calendarFields.extend({ timetable: timetableId });
const timetableSchema = z.strictObject({ label: text, periods });
export type CalendarConfig = z.infer<typeof schema>;
export type CalendarSourceConfig = z.infer<typeof sourceSchema>;
export type TimetableId = z.infer<typeof timetableId>;
export type SemesterConfig = Pick<CalendarConfig, 'semester' | 'semesterBinding'>;

export class ConfigError extends Error {
  constructor() { super('configuration:invalid'); this.name = 'ConfigError'; }
}

/** Safe, actionable messages contain only fixed paths, never file contents. */
export class TimetableConfigError extends ConfigError {
  constructor(public readonly guidance: string) { super(); this.name = 'TimetableConfigError'; }
}

export function validateSourceConfig(input: unknown): CalendarSourceConfig {
  const result = sourceSchema.safeParse(input);
  if (!result.success) throw new TimetableConfigError('校历须使用 timetable: "pku-main" 或 "pku-ss" 选择时间表，不再支持内联 periods；请检查其余校历字段。');
  return canonicalCalendarFields(result.data);
}

export function validateTimetable(input: unknown): z.infer<typeof timetableSchema> {
  const result = timetableSchema.safeParse(input);
  if (!result.success) throw new ConfigError();
  validatePeriods(result.data.periods);
  return result.data;
}

function validatePeriods(value: CalendarConfig['periods']): void {
  value.sort((a, b) => a.period - b.period);
  for (let i = 0; i < value.length; i++) {
    const p = value[i]!;
    if (p.start >= p.end || (i > 0 && value[i - 1]!.period === p.period)) throw new ConfigError();
  }
  // Upstream period numbers may need a non-chronological mapping. Keep the
  // canonical number order for fingerprints, but check overlaps by actual time.
  const chronological = [...value].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < chronological.length; i++) {
    if (chronological[i - 1]!.end > chronological[i]!.start) throw new ConfigError();
  }
}

/** Returns a canonical resolved configuration, also used as the cache fingerprint input. */
export function validateConfig(input: unknown): CalendarConfig {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConfigError();
  validatePeriods(result.data.periods);
  const config = canonicalCalendarFields(result.data);
  const supplements = validateCourseSupplements(config.courseSupplements, config);
  if (supplements) config.courseSupplements = supplements;
  else delete config.courseSupplements;
  return config;
}

function canonicalCalendarFields<T extends z.infer<typeof calendarFields>>(c: T): T {
  if (new Date(dateEpoch(c.firstMonday)).getUTCDay() !== 1) throw new ConfigError();
  const [year, next] = c.semester.split('-').map(Number);
  if (next !== year! + 1) throw new ConfigError();
  if (c.semesterBinding && (c.semesterBinding.confirmedSemester !== c.semester || c.semesterBinding.validFrom > c.semesterBinding.validThrough)) throw new ConfigError();
  if (c.unscheduledCourses) {
    const identities = c.unscheduledCourses.map(course => JSON.stringify([course.courseId, course.classId]));
    if (new Set(identities).size !== identities.length || c.unscheduledCourses.some(course => course.semester !== c.semester)) throw new ConfigError();
    c.unscheduledCourses.sort((a, b) => a.courseId.localeCompare(b.courseId) || a.classId.localeCompare(b.classId));
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

/** Supplements only enter the resolved runtime config, never public calendar JSON. */
export function configWithPrivateSupplements(input: unknown, json: string | undefined): CalendarConfig {
  const config = validateConfig(input);
  if (json === undefined || json.trim() === '') return config;
  if (config.courseSupplements !== undefined) throw new SupplementError('invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new SupplementError('invalid'); }
  const supplements = validateCourseSupplements(parsed, config);
  return supplements ? validateConfig({ ...config, courseSupplements: supplements }) : config;
}
