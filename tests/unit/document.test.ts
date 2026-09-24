import { expect, it } from 'vitest';
import { importFromHtml } from '../../src/application/import.js';
import { generateCalendar } from '../../src/application/generate.js';
import { parseWeeks, readScheduleYaml, resolveSchedule, writeScheduleYaml } from '../../src/schedule/document.js';
import { config, course, timetable } from '../fixtures/timetable.js';

const now = new Date('2026-09-24T00:00:00Z');
const document = () => importFromHtml(timetable(), config, now);
it('round trips editable Chinese YAML, comments, leading zero IDs and non-contiguous weeks', () => {
  const input = document(); input.courses[0]!.courseId = '00123456';
  const yaml = writeScheduleYaml(input);
  expect(yaml).toContain('#');
  expect(readScheduleYaml(yaml)).toEqual(input);
  expect(parseWeeks('1-4,6-8', 'odd', 8, 'weeks')).toEqual([1, 3, 7]);
  expect(parseWeeks('1-4,6-8', 'even', 8, 'weeks')).toEqual([2, 4, 6, 8]);
});
it.each([
  'version: 1\nversion: 1', 'version: 1\nsemester: &s "2026-2027-1"\ncourses: []',
  'version: 1\nsemester: *s\ncourses: []', 'version: 1\nsemester: !custom secret\ncourses: []',
  'version: 1\nsemester: "2026-2027-1"\ncourses: []\nprivate-unknown-key: secret',
])('rejects unsafe or malformed documents without echoing input %#', source => {
  expect(() => readScheduleYaml(source)).toThrow();
  try { readScheduleYaml(source); } catch (error) { expect(String(error)).not.toMatch(/private-unknown-key|secret/); }
});
it('requires textual identifiers and explicit ignored reasons', () => {
  const input = document();
  expect(() => readScheduleYaml(JSON.stringify({ ...input, courses: [{ ...input.courses[0], classId: 1 }] }))).toThrow('类型错误');
  expect(() => readScheduleYaml(JSON.stringify({ ...input, courses: [{ ...input.courses[0], slots: [{ status: 'ignored', sourceText: '待定' }] }] }))).toThrow();
});
it('retains unrecognized segments and blocks generation until edited or explicitly ignored', () => {
  const input = importFromHtml(timetable([{ course: { ...course, segments: [...course.segments, '(另行通知)'] } }]), config, now);
  expect(input.courses[0]!.slots.at(-1)).toEqual({ status: 'pending', sourceText: '(另行通知)' });
  expect(() => generateCalendar(input, config, now)).toThrow('待处理');
  input.courses[0]!.slots[2] = { status: 'ignored', sourceText: '(另行通知)', reason: '已确认无固定时间' };
  expect(generateCalendar(input, config, now)).toEqual(generateCalendar(document(), config, now));
});
it.each(['0', '5', '3-1', '1~4', '1,', '1-9999999999'])('rejects invalid teaching weeks %s', value => {
  expect(() => parseWeeks(value, 'all', 4, 'weeks')).toThrow();
});
it('rejects duplicate courses, duplicate events, missing periods and semester mismatch', () => {
  const input = document();
  expect(() => resolveSchedule({ ...input, courses: [...input.courses, ...input.courses] }, config)).toThrow('重复');
  input.courses[0]!.slots.push(input.courses[0]!.slots[0]!);
  expect(() => resolveSchedule(input, config)).toThrow('重复事件');
  expect(() => resolveSchedule(document(), { ...config, periods: config.periods.slice(0, 1) })).toThrow('缺少节次');
  expect(() => resolveSchedule({ ...document(), semester: '2025-2026-1' }, config)).toThrow('学期不一致');
});
it('permits an intentional empty schedule and preserves imported IDs across display edits', () => {
  expect(generateCalendar({ version: 1, semester: config.semester, courses: [] }, config, now).ics).not.toContain('VEVENT');
  const input = document();
  const original = generateCalendar(input, config, now).ics.match(/UID:[^\r]+/g);
  input.courses[0]!.name = '修改名称'; input.courses[0]!.slots.reverse();
  for (const slot of input.courses[0]!.slots) if (slot.status === 'scheduled') slot.location = '修改地点';
  expect(generateCalendar(input, config, now).ics.match(/UID:[^\r]+/g)).toEqual(original);
});
