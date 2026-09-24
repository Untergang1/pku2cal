import type { RawCourse } from '../pku/parser.js';
import { parseTime, ScheduleError } from '../schedule/time.js';

export interface UnscheduledCourseConfirmation {
  semester: string;
  courseId: string;
  classId: string;
  confirmed: true;
  expectedSegments: string[];
}

export function isConfirmedUnscheduled(course: RawCourse, decisions: UnscheduledCourseConfirmation[]): boolean {
  const decision = decisions.find(item => item.courseId === course.courseId && item.classId === course.classId);
  if (!decision) return false;
  if (decision.confirmed !== true || JSON.stringify(course.segments) !== JSON.stringify(decision.expectedSegments)) throw new ScheduleError('unscheduled_changed');
  for (const segment of course.segments) {
    let hasTime = false;
    try { parseTime(segment, 53); hasTime = true; } catch { /* Confirmed unstructured text. */ }
    if (hasTime) throw new ScheduleError('unscheduled_has_time');
  }
  return true;
}
