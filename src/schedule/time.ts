export class ScheduleError extends Error {
  constructor(public readonly code: 'time' | 'weeks' | 'periods' | 'duplicate' | 'date' | 'unscheduled_changed' | 'unscheduled_has_time') {
    super(`schedule:${code}`);
    this.name = 'ScheduleError';
  }
}

export interface Slot {
  weeks: number[];
  weekday: number;
  startPeriod: number;
  endPeriod: number;
  location: string;
}

export function parseTime(text: string, teachingWeeks: number): Slot {
  const normalized = text.normalize('NFKC').replace(/[～—]/g, '~').trim();
  const m = /^(\d+(?:\s*[~-]\s*\d+)?(?:\s*[,、]\s*\d+(?:\s*[~-]\s*\d+)?)*)\s*周\s*(?:(每|单|双)周\s*)?周([一二三四五六日天])\s*(\d+)(?:\s*[~-]\s*(\d+))?\s*节\s*(?:\((单|双)\)\s*)?(.*)$/u.exec(normalized);
  if (!m) throw new ScheduleError('time');
  const parity = m[2] === '每' ? m[6] : m[2] ?? m[6];
  if (m[2] && m[2] !== '每' && m[6] && m[2] !== m[6]) throw new ScheduleError('time');
  const weeks = new Set<number>();
  for (const part of m[1]!.split(/[,、]/)) {
    const [a, b] = part.split(/[~-]/).map(s => Number(s.trim()));
    const start = a!;
    const end = b ?? start;
    if (start < 1 || end < start || end > teachingWeeks) throw new ScheduleError('weeks');
    for (let week = start; week <= end; week++) {
      if (!parity || week % 2 === (parity === '单' ? 1 : 0)) weeks.add(week);
    }
  }
  if (!weeks.size) throw new ScheduleError('weeks');
  const startPeriod = Number(m[4]);
  const endPeriod = Number(m[5] ?? m[4]);
  if (startPeriod < 1 || endPeriod < startPeriod) throw new ScheduleError('periods');
  const weekday = m[3]!;
  const room = m[7]!.trim().replace(/^\((.*)\)$/s, '$1').trim();
  return { weeks: [...weeks].sort((a, b) => a - b), weekday: weekday === '天' ? 7 : '一二三四五六日'.indexOf(weekday) + 1, startPeriod, endPeriod, location: room };
}

export const DAY_MS = 86400000;
export function dateEpoch(date: string): number {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new ScheduleError('date');
  const epoch = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) throw new ScheduleError('date');
  return epoch;
}
export function addDays(date: string, days: number): string {
  return new Date(dateEpoch(date) + days * DAY_MS).toISOString().slice(0, 10);
}
