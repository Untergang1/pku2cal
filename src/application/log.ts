import { PkuError } from '../pku/http.js';
import { ParseError } from '../pku/parser.js';
import { ScheduleError } from '../schedule/time.js';
import { CalendarError } from '../calendar/ics.js';
import { ConfigError } from './config.js';

export interface LogRecord { stage: 'generate' | 'cache' | 'configuration'; category: string; durationMs: number }
export type Logger = (record: LogRecord) => void;
export const logRecord: Logger = record => console.log(JSON.stringify(record));

export function errorCategory(error: unknown): string {
  if (error instanceof PkuError) return `pku:${error.code}`;
  if (error instanceof ParseError) return `parse:${error.code}`;
  if (error instanceof ScheduleError) return `schedule:${error.code}`;
  if (error instanceof CalendarError) return 'calendar:invalid';
  if (error instanceof ConfigError) return 'configuration:invalid';
  return 'internal';
}
