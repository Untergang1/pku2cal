import { z } from 'zod';
import { isAlias, isCollection, isScalar, LineCounter, parseDocument, stringify, visit } from 'yaml';
import type { CalendarConfig } from '../application/config.js';
import type { ScheduledCourse } from './expand.js';

export class DocumentError extends Error {
  constructor(public readonly field: string, public readonly problem: string) {
    super(`课表 ${field}：${problem}`);
    this.name = 'DocumentError';
  }
}
const text = z.string().refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const required = text.refine(value => value.trim().length > 0);
const period = z.number().int().min(1).max(30);
const slot = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('scheduled'), weekday: z.number().int().min(1).max(7),
    startPeriod: period, endPeriod: period, weeks: required, parity: z.enum(['all', 'odd', 'even']), location: text }),
  z.strictObject({ status: z.literal('pending'), sourceText: required }),
  z.strictObject({ status: z.literal('ignored'), sourceText: required, reason: required }),
]);
export const documentSchema = z.strictObject({
  version: z.literal(1), semester: z.string().regex(/^20\d{2}-20\d{2}-[123]$/), importedAt: z.iso.datetime().optional(),
  courses: z.array(z.strictObject({ courseId: required, classId: required, name: required, teacher: text, slots: z.array(slot).min(1) })),
});
export type ScheduleDocument = z.infer<typeof documentSchema>;
export type DocumentSlot = ScheduleDocument['courses'][number]['slots'][number];
const known = new Set(['version', 'semester', 'importedAt', 'courses', 'courseId', 'classId', 'name', 'teacher', 'slots',
  'status', 'weekday', 'startPeriod', 'endPeriod', 'weeks', 'parity', 'location', 'sourceText', 'reason']);
function safePath(path: PropertyKey[]): string {
  return path.map(p => typeof p === 'number' ? `[${p}]` : known.has(String(p)) ? String(p) : '?').join('.') || '$';
}
export function validateDocument(input: unknown): ScheduleDocument {
  const result = documentSchema.safeParse(input);
  if (!result.success) throw new DocumentError(safePath(result.error.issues[0]!.path), '字段缺失、类型错误或存在不支持的字段');
  return result.data;
}
export function readScheduleYaml(source: string): ScheduleDocument {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { version: '1.2', uniqueKeys: true, lineCounter });
  const issue = doc.errors[0] ?? doc.warnings[0];
  if (issue) {
    const pos = lineCounter.linePos(issue.pos[0]);
    throw new DocumentError(`第 ${pos.line} 行第 ${pos.col} 列`, 'YAML 语法、重复字段或标签错误');
  }
  visit(doc, (_, node) => {
    if (isAlias(node) || ((isScalar(node) || isCollection(node)) && (node.anchor || node.tag))) {
      throw new DocumentError('$', '不支持标签、锚点或别名');
    }
  });
  return validateDocument(doc.toJS({ maxAliasCount: 0 }));
}
export function writeScheduleYaml(document: ScheduleDocument): string {
  return '# 本文件是课程数据的唯一来源；生成与发布不会改写本文件。\n'
    + '# 星期：1=周一，7=周日；教学周："1-8,10-16"；parity：all / odd / even。\n'
    + '# pending 必须补全为 scheduled，或改为 ignored 并填写 reason 后才能发布。\n'
    + stringify(validateDocument(document), { version: '1.2', lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN'  });
}
export function parseWeeks(value: string, parity: 'all' | 'odd' | 'even', maximum: number, path: string): number[] {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw new DocumentError(path, '教学周须为数字或闭区间，以英文逗号分隔');
  const weeks = new Set<number>();
  for (const range of value.split(',')) {
    const [start = 0, end = start] = range.split('-').map(Number);
    if (start < 1 || end < start || end > maximum) throw new DocumentError(path, '教学周超出范围或区间倒置');
    for (let week = start; week <= end; week++) if (parity === 'all' || week % 2 === (parity === 'odd' ? 1 : 0)) weeks.add(week);
  }
  if (!weeks.size) throw new DocumentError(path, '筛选后没有教学周');
  return [...weeks].sort((a, b) => a - b);
}
/** Validate all resolvable slots even when other slots still need review. */
export function resolveSchedule(input: unknown, config: CalendarConfig, allowPending = false): ScheduledCourse[] {
  const document = validateDocument(input);
  if (document.semester !== config.semester) throw new DocumentError('semester', '与校历学期不一致');
  const courses = new Set<string>();
  const periods = new Set(config.periods.map(p => p.period));
  return document.courses.map((course, i) => {
    const path = `courses[${i}]`;
    const id = JSON.stringify([course.courseId, course.classId]);
    if (courses.has(id)) throw new DocumentError(path, '课程号和班号重复');
    courses.add(id);
    const identities = new Set<string>();
    const slots = course.slots.flatMap((item, j) => {
      const field = `${path}.slots[${j}]`;
      if (item.status === 'ignored') return [];
      if (item.status === 'pending') {
        if (!allowPending) throw new DocumentError(field, '仍有待处理时段，请补全或明确忽略');
        return [];
      }
      if (item.endPeriod < item.startPeriod) throw new DocumentError(field, '节次区间倒置');
      for (let p = item.startPeriod; p <= item.endPeriod; p++) if (!periods.has(p)) throw new DocumentError(field, '所选作息时间表缺少节次');
      const weeks = parseWeeks(item.weeks, item.parity, config.teachingWeeks, `${field}.weeks`);
      for (const week of weeks) {
        const key = JSON.stringify([week, item.weekday, item.startPeriod, item.endPeriod]);
        if (identities.has(key)) throw new DocumentError(field, '重复事件');
        identities.add(key);
      }
      return [{ weekday: item.weekday, startPeriod: item.startPeriod, endPeriod: item.endPeriod, weeks, location: item.location }];
    });
    return { courseId: course.courseId, classId: course.classId, name: course.name, teacher: course.teacher, slots };
  });
}
