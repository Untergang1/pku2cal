import { load } from 'cheerio/slim';

export interface RawCourse {
  courseId: string;
  classId: string;
  name: string;
  teacher: string;
  segments: string[];
}
export interface ParsedTimetable { courses: RawCourse[]; semester: string | null }
export class ParseError extends Error {
  constructor(public readonly code: 'structure' | 'status' | 'pagination' | 'identity' | 'semester') {
    super(`parse:${code}`);
    this.name = 'ParseError';
  }
}

const required = ['课程号', '课程名', '教师', '班号', '教室信息', '选课结果'];
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

export function parseTimetable(html: string): ParsedTimetable {
  const $ = load(html);
  const tables = $('table.datagrid');
  if (tables.length !== 1) throw new ParseError('structure');
  const rows = tables.first().find('tr').filter((_, row) => $(row).closest('table')[0] === tables[0]).toArray();
  const header = rows.shift();
  if (!header) throw new ParseError('structure');
  const labels = $(header).children('th,td').toArray().map(cell => normalize($(cell).text()));
  if (required.some(name => labels.filter(label => label === name).length !== 1)) throw new ParseError('structure');
  const columns = Object.fromEntries(required.map(name => [name, labels.indexOf(name)]));
  const courses: RawCourse[] = [];
  const identities = new Set<string>();
  let explicitEmpty = false;
  for (const row of rows) {
    const cells = $(row).children('td,th');
    const rowText = normalize($(row).text());
    if (!cells.length && !rowText) continue;
    if (cells.length === 1 && Number(cells.first().attr('colspan')) === labels.length) {
      const page = /^Page\s+(\d+)\s+of\s+(\d+)(?:\s|$)/i.exec(rowText);
      if (page) {
        if (page[1] !== '1' || page[2] !== '1') throw new ParseError('pagination');
        continue;
      }
      if (/^(?:暂无选课记录|没有选课记录)$/.test(rowText)) { explicitEmpty = true; continue; }
      throw new ParseError('structure');
    }
    if (cells.length !== labels.length || explicitEmpty) throw new ParseError('structure');
    const field = (label: string) => normalize(cells.eq(columns[label]!).text());
    const status = field('选课结果');
    if (status === '未选上') continue;
    if (status !== '已选上') throw new ParseError('status');
    const courseId = field('课程号');
    const classId = field('班号');
    const name = field('课程名');
    if (!courseId || !classId || !name) throw new ParseError('identity');
    const identity = JSON.stringify([courseId, classId]);
    if (identities.has(identity)) throw new ParseError('identity');
    identities.add(identity);
    const time = cells.eq(columns['教室信息']!).clone();
    time.find('br').replaceWith('\n');
    const segments = time.text().split(/\r?\n/).map(normalize).filter(Boolean);
    if (!segments.length) throw new ParseError('structure');
    courses.push({ courseId, classId, name, teacher: field('教师'), segments });
  }
  if (explicitEmpty && courses.length) throw new ParseError('structure');
  // Only an explicit academic caption is evidence; operation timestamps are not.
  const caption = normalize($('caption').text());
  const matches = [...caption.matchAll(/(20\d{2})\s*[-—~～]\s*(20\d{2})\s*学年\s*第?([一二三123])学期/g)];
  const terms = new Set(matches.map(m => `${m[1]}-${m[2]}-${({ 一: 1, 二: 2, 三: 3 } as Record<string, number>)[m[3]!] ?? m[3]}`));
  if (terms.size > 1) throw new ParseError('semester');
  return { courses, semester: [...terms][0] ?? null };
}
