import { z } from 'zod';
import type { RawCourse } from '../pku/parser.js';
import { parseTime, type Slot } from '../schedule/time.js';
import { isConfirmedUnscheduled, type UnscheduledCourseConfirmation } from './unscheduled.js';

export class SupplementError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'duplicate') {
    super(`supplements:${code}`);
    this.name = 'SupplementError';
  }
}

const text = z.string().trim().refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const requiredText = text.refine(value => value.length > 0);
const identity = { courseId: requiredText, classId: requiredText };
const period = z.number().int().min(1).max(30);
export const courseSupplementsSchema = z.strictObject({
  semester: z.string().regex(/^20\d{2}-20\d{2}-[123]$/),
  locations: z.array(z.strictObject({ ...identity, location: requiredText })),
  courses: z.array(z.strictObject({
    ...identity, name: requiredText, teacher: text.default(''), location: text.default(''),
    slots: z.array(z.strictObject({
      weekday: z.number().int().min(1).max(7), startPeriod: period, endPeriod: period,
      weeks: z.strictObject({
        start: z.number().int().min(1), end: z.number().int().min(1), parity: z.enum(['all', 'odd', 'even']),
      }),
    })).min(1),
  })),
});
export type CourseSupplements = z.infer<typeof courseSupplementsSchema>;
interface SupplementContext {
  semester: string;
  teachingWeeks: number;
  periods: { period: number }[];
  unscheduledCourses?: UnscheduledCourseConfirmation[] | undefined;
}
export interface ScheduledCourse extends Omit<RawCourse, 'segments'> { slots: Slot[] }
const key = (course: { courseId: string; classId: string }) => JSON.stringify([course.courseId, course.classId]);
const compareIdentity = (a: { courseId: string; classId: string }, b: { courseId: string; classId: string }) =>
  a.courseId.localeCompare(b.courseId) || a.classId.localeCompare(b.classId);

function weeksOf(slot: CourseSupplements['courses'][number]['slots'][number]): number[] {
  const { start, end, parity } = slot.weeks;
  const result: number[] = [];
  for (let week = start; week <= end; week++) {
    if (parity === 'all' || week % 2 === (parity === 'odd' ? 1 : 0)) result.push(week);
  }
  return result;
}

/** Canonical order is also the Worker cache fingerprint order. Never mutate input. */
export function validateCourseSupplements(input: unknown, context: SupplementContext): CourseSupplements | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = courseSupplementsSchema.safeParse(input);
  if (!parsed.success) throw new SupplementError('invalid');
  const value = parsed.data;
  if (value.semester !== context.semester) throw new SupplementError('invalid');
  const locations = new Set(value.locations.map(key));
  const courses = new Set(value.courses.map(key));
  if (locations.size !== value.locations.length || courses.size !== value.courses.length) throw new SupplementError('invalid');
  const confirmations = new Set((context.unscheduledCourses ?? []).map(key));
  const periods = new Set(context.periods.map(p => p.period));
  for (const course of value.courses) {
    if (locations.has(key(course)) || confirmations.has(key(course))) throw new SupplementError('conflict');
    const seen = new Set<string>();
    for (const slot of course.slots) {
      if (slot.weeks.start > slot.weeks.end || slot.weeks.end > context.teachingWeeks || slot.endPeriod < slot.startPeriod) throw new SupplementError('invalid');
      for (let p = slot.startPeriod; p <= slot.endPeriod; p++) {
        if (!periods.has(p)) throw new SupplementError('invalid');
      }
      const weeks = weeksOf(slot);
      if (!weeks.length) throw new SupplementError('invalid');
      for (const week of weeks) {
        const id = JSON.stringify([week, slot.weekday, slot.startPeriod, slot.endPeriod]);
        if (seen.has(id)) throw new SupplementError('duplicate');
        seen.add(id);
      }
    }
    course.slots.sort((a, b) => a.weekday - b.weekday || a.startPeriod - b.startPeriod || a.endPeriod - b.endPeriod
      || a.weeks.start - b.weeks.start || a.weeks.end - b.weeks.end || a.weeks.parity.localeCompare(b.weeks.parity));
  }
  value.locations.sort(compareIdentity);
  value.courses.sort(compareIdentity);
  return value.locations.length || value.courses.length ? value : undefined;
}

/** Resolve upstream text once; manual slots go directly into the same expansion path. */
export function supplementCourses(courses: RawCourse[], context: SupplementContext, input?: CourseSupplements): ScheduledCourse[] {
  const supplements = validateCourseSupplements(input, context);
  const upstream = new Set(courses.map(key));
  if (supplements?.courses.some(course => upstream.has(key(course)))) throw new SupplementError('conflict');
  const locations = new Map(supplements?.locations.map(course => [key(course), course.location]));
  const result: ScheduledCourse[] = [];
  for (const course of courses) {
    if (isConfirmedUnscheduled(course, context.unscheduledCourses ?? [])) continue;
    const { segments, ...info } = course;
    result.push({ ...info, slots: segments.map(segment => {
      const slot = parseTime(segment, context.teachingWeeks);
      return { ...slot, location: locations.get(key(course)) ?? slot.location };
    }) });
  }
  for (const course of supplements?.courses ?? []) {
    result.push({ courseId: course.courseId, classId: course.classId, name: course.name, teacher: course.teacher,
      slots: course.slots.map(slot => ({ weekday: slot.weekday, startPeriod: slot.startPeriod,
        endPeriod: slot.endPeriod, weeks: weeksOf(slot), location: course.location })) });
  }
  return result;
}
