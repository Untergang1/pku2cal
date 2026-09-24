import { validateSourceConfig, type CalendarSourceConfig, type SemesterConfig } from './config.js';
import { assertGenerationAllowed, SemesterWindowError } from './semester.js';

export interface SemesterPreset {
  label: string;
  source: string;
  calendar: unknown;
  validThrough: string;
}

export class SetupError extends Error {
  constructor(public readonly code: 'no_current' | 'ambiguous' | 'unknown_semester' | 'exists' | 'catalogue') {
    super(`setup:${code}`);
    this.name = 'SetupError';
  }
}

export interface SemesterSelection {
  label: string;
  source: string;
  config: CalendarSourceConfig;
}

/** Uses curated calendar dates; no month-based guess or upstream login is needed. */
export function selectSemester(presets: SemesterPreset[], now: Date, semester?: string): SemesterSelection {
  if (!Number.isFinite(now.getTime())) throw new SemesterWindowError('invalid_clock');
  const selections = presets.map(preset => {
    const calendar = validateSourceConfig(preset.calendar);
    const config = validateSourceConfig({ ...calendar, semesterBinding: {
      confirmedSemester: calendar.semester,
      validFrom: calendar.firstMonday,
      validThrough: preset.validThrough,
    } });
    return { label: preset.label, source: preset.source, config };
  });
  const matches = selections.filter(selection => {
    if (semester !== undefined) return selection.config.semester === semester;
    try { assertGenerationAllowed(selection.config, now); return true; }
    catch (error) { if (error instanceof SemesterWindowError) return false; throw error; }
  });
  if (!matches.length) throw new SetupError(semester === undefined ? 'no_current' : 'unknown_semester');
  if (matches.length !== 1) throw new SetupError('ambiguous');
  return matches[0]!;
}

export function semesterStatus(config: SemesterConfig, now: Date): string[] {
  let state = '可以生成';
  try { assertGenerationAllowed(config, now); }
  catch (error) {
    if (!(error instanceof SemesterWindowError) || error.code === 'invalid_clock') throw error;
    state = error.code === 'not_started' ? '尚未开始，暂不生成' : '学期已结束，停止生成';
  }
  const date = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const binding = config.semesterBinding;
  return [
    `北京时间：${date}`,
    `已选学期：${config.semester}`,
    binding ? `生成有效期：${binding.validFrom} 至 ${binding.validThrough}（含首尾两天）` : '学期尚未绑定；生成时需要上游提供匹配的学期标识。',
    ...(binding ? [`日期检查：${state}`] : []),
  ];
}
