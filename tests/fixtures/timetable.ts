import type { RawCourse } from '../../src/pku/parser.js';
import type { CalendarConfig } from '../../src/application/config.js';

export const config: CalendarConfig = {
  namespace: 'synthetic-calendar', semester: '2026-2027-1', firstMonday: '2026-09-07', teachingWeeks: 4,
  periods: [
    { period: 1, start: '08:00', end: '08:50' }, { period: 2, start: '09:00', end: '09:50' },
    { period: 3, start: '10:10', end: '11:00' }, { period: 4, start: '11:10', end: '12:00' },
  ], holidays: [], makeups: {},
};
export const course: RawCourse = {
  courseId: 'SYN001', classId: '01', name: '合成课程', teacher: '合成教师',
  segments: ['1~4周 每周周一1~2节(示例教室)', '1~4周 周三3~4节(单) 另一教室'],
};
export function timetable(rows: { course?: RawCourse; status?: string }[] = [{ course }], caption = '2026-2027学年第一学期课程表'): string {
  const headers = ['课程号', '课程名', '课程类别', '学分', '周学时', '教师', '班号', '开课单位', '教室信息', '选课结果', 'IP地址', '操作时间'];
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<html><body><table><caption>${caption}</caption></table><table class="datagrid"><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map(row => {
    const c = row.course ?? course;
    const fields = [c.courseId, c.name, '合成类别', '2', '2', c.teacher, c.classId, '合成单位'];
    return `<tr>${fields.map(s => `<td>${escape(s)}</td>`).join('')}<td>${c.segments.map(escape).join('<br>')}</td><td>${row.status ?? '已选上'}</td><td></td><td></td></tr>`;
  }).join('')}<tr></tr><tr><td colspan="12">Page 1 of 1 First / Previous Next / Last</td></tr></table></body></html>`;
}
