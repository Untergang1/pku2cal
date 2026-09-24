import type { SemesterConfig } from './config.js';
import { ParseError } from '../pku/parser.js';

export class SemesterWindowError extends Error {
  constructor(public readonly code: 'not_started' | 'expired' | 'invalid_clock') {
    super(`semester:${code}`);
    this.name = 'SemesterWindowError';
  }
}

/** Date bounds are inclusive Shanghai calendar dates, independent of host TZ. */
export function assertGenerationAllowed(config: SemesterConfig, now: Date): void {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new SemesterWindowError('invalid_clock');
  const binding = config.semesterBinding;
  if (!binding) return;
  const start = Date.parse(`${binding.validFrom}T00:00:00+08:00`);
  const endExclusive = Date.parse(`${binding.validThrough}T00:00:00+08:00`) + 86400000;
  if (timestamp < start) throw new SemesterWindowError('not_started');
  if (timestamp >= endExclusive) throw new SemesterWindowError('expired');
}

export function assertSemesterMatches(config: SemesterConfig, upstreamSemester: string | null): void {
  // A manual binding authorizes missing evidence, never contradictory evidence.
  if (upstreamSemester !== null ? upstreamSemester !== config.semester : !config.semesterBinding) throw new ParseError('semester');
}
