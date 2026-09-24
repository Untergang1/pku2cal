import { load } from 'cheerio';
import { addDays, dateEpoch, DAY_MS } from '../schedule/time.js';
import type { Fetch } from './http.js';

export const CALENDAR_URL = 'https://www.pku.edu.cn/detail/3377.html';

export class CalendarPullError extends Error {
  constructor(public readonly guidance: string) { super(guidance); this.name = 'CalendarPullError'; }
}
const invalid = () => new CalendarPullError('官方校历结构或日期无法明确解析，请核对来源页面；未保存配置。');

export interface AcademicSemester {
  semester: string;
  firstMonday: string;
  teachingWeeks: number;
  validThrough: string;
  holidays: string[];
  makeups: Record<string, string>;
  notices: string[];
}

/** Public retrieval is separate from authenticated elective sessions. */
export async function fetchAcademicCalendar(fetcher: Fetch): Promise<string> {
  let url = new URL(CALENDAR_URL);
  const signal = AbortSignal.timeout(15_000);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetcher(url.href, {
        redirect: 'manual', signal, headers: { 'user-agent': 'pku2cal/0.1', 'cache-control': 'no-cache' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 5) throw new Error();
        const next = new URL(location, url);
        if (next.origin !== new URL(CALENDAR_URL).origin || next.username || next.password) throw new Error();
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      return await response.text();
    }
  } catch { /* Do not expose arbitrary upstream errors. */ }
  throw new CalendarPullError('无法获取官方校历，请检查网络或官方页面；未使用旧预设替代。');
}

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').replace(/[—–～]/g, '-');
const atom = '(?:(20\\d{2})年)?(\\d{1,2})月(\\d{1,2})日';
const rangePattern = new RegExp(`^${atom}(?:(?:至|-|~)(?:(20\\d{2})年)?(?:(\\d{1,2})月)?(\\d{1,2})日)?$`);

function dateRange(text: string, year: number, term: number): [string, string] {
  const match = rangePattern.exec(text);
  if (!match) throw invalid();
  const month = Number(match[2]);
  const startYear = Number(match[1] ?? (term === 1 && month >= 8 ? year : year + 1));
  const endMonth = Number(match[5] ?? month);
  const endYear = Number(match[4] ?? (startYear + (endMonth < month ? 1 : 0)));
  const format = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const start = format(startYear, month, Number(match[3]));
  const end = format(endYear, endMonth, Number(match[6] ?? match[3]));
  try {
    dateEpoch(start); dateEpoch(end);
    if (start > end || start < `${year}-08-01` || end >= `${year + 1}-08-01`) throw invalid();
    if (term === 2 && start < `${year + 1}-01-01`) throw invalid();
  } catch { throw invalid(); }
  return [start, end];
}

/** A campus prefix scopes subsequent lines until the next heading or prefix. */
function campusLine(line: string): { text: string; applies: boolean } | undefined {
  const match = /^((?:(?:校本部|医学部|深圳研究生院)(?:、|和)?)+):(.*)$/.exec(line);
  if (!match) return undefined;
  return { text: match[2]!, applies: match[1]!.includes('校本部') };
}

function parseTerm(lines: string[], year: number, term: number): AcademicSemester {
  let section = '';
  let applies = true;
  let pendingPolicy = false;
  const starts: string[] = [];
  const exams: [string, string][] = [];
  const holidays = new Set<string>();
  const ordinary = new Set<string>();
  const makeups: Record<string, string> = {};
  const notices = new Set<string>();
  const expand = ([start, end]: [string, string]) => {
    const dates: string[] = [];
    for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
    return dates;
  };
  for (const raw of lines) {
    let line = raw;
    const heading = /^[一二三四五六七八九十百]+、([^:]+)(?::(.*))?$/.exec(line);
    if (heading) {
      if (pendingPolicy) throw invalid();
      section = heading[1]!;
      applies = true;
      pendingPolicy = !['上课', '停课复习考试'].includes(section) && /停课|补课|调课|课程|调休|放假|上课|休课|教学/.test(section);
      line = heading[2] ?? '';
      if (!line) continue;
    }
    const campus = campusLine(line);
    if (campus) { applies = campus.applies; line = campus.text; }
    if (/全校/.test(line) || (!campus && /另行通知/.test(line))) applies = true;
    if (!applies) continue;
    if (/另行通知/.test(line)) {
      if (/元旦|清明|端午|节|放假|停课|补课|调课/.test(line)) notices.add(line);
      else if (pendingPolicy) notices.add(`${section}：${line}`);
      // Never silently drop an already specified policy on the same line.
      if (/\d{1,2}月\d{1,2}日/.test(line) && /停课|补课|调课/.test(line)) throw invalid();
      pendingPolicy = false;
      continue;
    }
    if (section === '上课') {
      if (/^教职工/.test(line)) continue;
      const dates = dateRange(line, year, term);
      if (dates[0] !== dates[1]) throw invalid();
      starts.push(dates[0]);
      continue;
    }
    if (section === '停课复习考试') { exams.push(dateRange(line, year, term)); continue; }

    // Only literal dates establish a makeup identity; “补周一的课” is ambiguous.
    const makeup = new RegExp(`^(${atom})[,，]?补(?:上)?(${atom})(?:的)?课[。.]?$`).exec(line);
    if (makeup) {
      const target = dateRange(makeup[1]!, year, term)[0];
      const source = dateRange(makeup[5]!, year, term)[0];
      if (makeups[target] !== undefined && makeups[target] !== source) throw invalid();
      makeups[target] = source;
      pendingPolicy = false;
      continue;
    }
    if (/补课|补上|调课|课程调整|补.*课/.test(line)) throw invalid();
    const policy = /^(.*?)[,，](.*?)[。.]?$/.exec(line);
    if (policy && /(?:全校|校本部)?停课/.test(policy[2]!)) {
      const description = policy[2]!;
      if (!/^(?:(?:中秋节|国庆节|元旦|清明节|端午节|劳动节|放假|放假调休|校庆相关单位上班)[,，])*(?:全校|校本部)?停课$/.test(description)) throw invalid();
      for (const date of expand(dateRange(policy[1]!, year, term))) holidays.add(date);
      pendingPolicy = false;
    } else if (policy && /课程照常进行/.test(policy[2]!)) {
      if (!/^(?:公休[,，])?课程照常进行$/.test(policy[2]!)) throw invalid();
      for (const date of expand(dateRange(policy[1]!, year, term))) ordinary.add(date);
      pendingPolicy = false;
    } else if (/停课|补课|调休|放假|课程|上课|休课|教学/.test(line) || pendingPolicy || /停课|补课|调休|放假|课程调整/.test(section)) {
      throw invalid();
    }
  }
  if (pendingPolicy || starts.length !== 1 || exams.length !== 1) throw invalid();
  const firstMonday = starts[0]!;
  const [examStart, validThrough] = exams[0]!;
  const teachingWeeks = (dateEpoch(examStart) - dateEpoch(firstMonday)) / (7 * DAY_MS);
  if (new Date(dateEpoch(firstMonday)).getUTCDay() !== 1 || !Number.isInteger(teachingWeeks) || teachingWeeks < 1 || teachingWeeks > 53) throw invalid();
  if (term === 1 && firstMonday.slice(0, 4) !== String(year)) throw invalid();
  if ([...holidays, ...ordinary, ...Object.keys(makeups), ...Object.values(makeups)].some(date => date < firstMonday || date > validThrough)) throw invalid();
  if ([...ordinary].some(date => holidays.has(date) || date in makeups || Object.values(makeups).includes(date))) throw invalid();
  return { semester: `${year}-${year + 1}-${term}`, firstMonday, teachingWeeks, validThrough,
    holidays: [...holidays].sort(), makeups, notices: [...notices] };
}

/** Parse only the requested term, so another term's pending changes cannot block it. */
export function parseAcademicCalendar(html: string, semester?: string): AcademicSemester[] {
  const $ = load(html);
  const root = $('.school_calendar');
  const title = normalize(root.find('.tit').text());
  const academicYear = /^北京大学(20\d{2})-(20\d{2})学年校历$/.exec(title);
  if (root.length !== 1 || !academicYear || Number(academicYear[2]) !== Number(academicYear[1]) + 1 || root.find('.txt').length !== 1) throw invalid();
  const year = Number(academicYear[1]);
  const body = root.find('.txt').clone();
  // Only the trailing timetable is outside this parser's scope. Do not lose
  // policies silently if an upstream editor moves calendar entries into a table.
  for (const table of body.find('table').toArray()) {
    if (!$(table).prevAll('p').toArray().some(p => /^北京大学.*学年上课时间$/.test(normalize($(p).text())))
      || /停课|补课|放假|调休|课程/.test($(table).text())) throw invalid();
  }
  body.find('table, script, style').remove();
  body.find('br').replaceWith('§');
  const remainder = body.clone();
  remainder.find('p').remove();
  if (normalize(remainder.text()).replace(/§/g, '')) throw invalid();
  const lines = body.find('p').toArray().flatMap(element => $(element).text().split('§').map(normalize)).filter(Boolean);
  const first = lines.indexOf('第一学期');
  const second = lines.indexOf('第二学期');
  const end = lines.findIndex(line => /^北京大学.*学年上课时间$/.test(line));
  if (first < 0 || second <= first || lines.filter(line => /^(第一|第二)学期$/.test(line)).length !== 2) throw invalid();
  const sections = [lines.slice(first + 1, second), lines.slice(second + 1, end < 0 ? undefined : end)];
  const selected = sections.map((section, i) => ({ section, term: i + 1 }))
    .filter(({ term }) => semester === undefined || semester === `${year}-${year + 1}-${term}`);
  if (!selected.length) throw new CalendarPullError('官方页面未收录指定学期，请核对 --semester 和来源页面。');
  return selected.map(({ section, term }) => parseTerm(section, year, term));
}
