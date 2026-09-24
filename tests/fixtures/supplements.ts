import type { CourseSupplements } from '../../src/migration/supplements.js';
import { config, course } from './timetable.js';

export const supplements: CourseSupplements = {
  semester: config.semester,
  locations: [{ courseId: course.courseId, classId: course.classId, location: '手动教室，101' }],
  courses: [{
    courseId: 'SYN003', classId: '01', name: '合成单周课程', teacher: '', location: '合成教室 202',
    slots: [{ weekday: 3, startPeriod: 1, endPeriod: 2, weeks: { start: 1, end: 4, parity: 'odd' } }],
  }],
};
