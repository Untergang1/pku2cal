import { validateSourceConfig, type CalendarSourceConfig } from './config.js';
import { CalendarPullError, fetchAcademicCalendar, parseAcademicCalendar, type AcademicSemester } from '../pku/academic-calendar.js';
import type { Fetch } from '../pku/http.js';

export interface CalendarPullResult {
  config: CalendarSourceConfig;
  notices: string[];
  changes: string[];
}

export async function importCalendar(options: {
  previous?: CalendarSourceConfig; semester?: string; fetch: Fetch; now: Date;
}): Promise<CalendarPullResult> {
  const requested = options.semester ?? options.previous?.semester;
  if (requested !== undefined && !/^20\d{2}-20\d{2}-[12]$/.test(requested)) throw new CalendarPullError('请用 --semester 指定春秋学期，例如 2026-2027-1。');
  if (!Number.isFinite(options.now.getTime())) throw new CalendarPullError('系统日期无效，请检查时间设置。');
  const terms = parseAcademicCalendar(await fetchAcademicCalendar(options.fetch), requested);
  const today = new Date(options.now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const matches = requested ? terms : terms.filter(term => term.firstMonday <= today && today <= term.validThrough);
  if (matches.length !== 1) throw new CalendarPullError('当前日期没有唯一匹配的官方学期，请用 --semester 明确指定。');
  return assembleCalendar(matches[0]!, options.previous);
}

function assembleCalendar(term: AcademicSemester, previous?: CalendarSourceConfig): CalendarPullResult {
  const config = validateSourceConfig({
    namespace: previous?.namespace ?? 'pku-main-calendar',
    timetable: previous?.timetable ?? 'pku-ss',
    semester: term.semester,
    semesterBinding: { confirmedSemester: term.semester, validFrom: term.firstMonday, validThrough: term.validThrough },
    firstMonday: term.firstMonday, teachingWeeks: term.teachingWeeks, holidays: term.holidays, makeups: term.makeups,
  });
  const changes: string[] = [];
  for (const key of Object.keys(config) as (keyof CalendarSourceConfig)[]) {
    const before = previous?.[key];
    const after = config[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(`${key}: ${before === undefined ? '（未设置）' : JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
  return { config, notices: term.notices, changes };
}
