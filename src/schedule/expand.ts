import { createHash } from 'node:crypto';
import { addDays, ScheduleError, type Slot } from './time.js';

export interface ScheduledCourse { courseId: string; classId: string; name: string; teacher: string; slots: Slot[] }

export interface ScheduleConfig {
  namespace: string;
  semester: string;
  firstMonday: string;
  teachingWeeks: number;
  periods: { period: number; start: string; end: string }[];
  holidays: string[];
  makeups: Record<string, string>;
}
export interface CalendarEvent {
  uid: string;
  originalDate: string;
  start: string;
  end: string;
  summary: string;
  location: string;
  description: string;
}

export function expandCourses(courses: ScheduledCourse[], config: ScheduleConfig): CalendarEvent[] {
  const moved = new Map(Object.entries(config.makeups).map(([target, source]) => [source, target]));
  const targets = new Set(Object.keys(config.makeups));
  const cancelled = new Set(config.holidays);
  const periods = new Map(config.periods.map(p => [p.period, p]));
  const events: CalendarEvent[] = [];
  const identities = new Set<string>();
  for (const course of courses) {
    for (const slot of course.slots) {
      const mappedPeriods = [];
      for (let p = slot.startPeriod; p <= slot.endPeriod; p++) {
        const current = periods.get(p);
        if (!current) throw new ScheduleError('periods');
        mappedPeriods.push(current);
      }
      // Period numbers identify the selected lessons; their mapped clock times
      // determine the event bounds, including any remapped interior period.
      mappedPeriods.sort((a, b) => a.start.localeCompare(b.start));
      const startTime = mappedPeriods[0]!.start;
      const endTime = mappedPeriods[mappedPeriods.length - 1]!.end;
      for (const week of slot.weeks) {
        const originalDate = addDays(config.firstMonday, (week - 1) * 7 + slot.weekday - 1);
        const identity = JSON.stringify([config.namespace, config.semester, course.courseId, course.classId, originalDate, slot.weekday, slot.startPeriod, slot.endPeriod]);
        if (identities.has(identity)) throw new ScheduleError('duplicate');
        identities.add(identity);
        const date = moved.get(originalDate) ?? originalDate;
        // A moved day always comes from the standard schedule, before holidays.
        if (!moved.has(originalDate) && (cancelled.has(date) || targets.has(date))) continue;
        events.push({
          uid: `${createHash('sha256').update(identity).digest('hex')}@pku2cal`, originalDate,
          start: new Date(`${date}T${startTime}:00+08:00`).toISOString(),
          end: new Date(`${date}T${endTime}:00+08:00`).toISOString(),
          summary: course.name, location: slot.location,
          description: `课程号：${course.courseId}\n班号：${course.classId}\n教师：${course.teacher}`,
        });
      }
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
}
