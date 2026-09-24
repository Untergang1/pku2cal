import { createHash, timingSafeEqual } from 'node:crypto';
import { configWithPrivateConfirmations, validateConfig, type CalendarConfig } from '../application/config.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { generateCalendar, type GeneratedCalendar } from '../application/generate.js';
import { errorCategory, logRecord, type Logger } from '../application/log.js';
import type { Fetch } from '../pku/http.js';

export interface CalendarStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
export interface WorkerEnv {
  PKU_USERNAME?: string;
  PKU_PASSWORD?: string;
  CALENDAR_TOKEN?: string;
  PKU_UNSCHEDULED_COURSES?: string;
  CALENDAR_KV: CalendarStore;
}
interface Snapshot extends GeneratedCalendar { fingerprint: string }
export const REFRESH_MS = 6 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function cacheIdentity(config: unknown, username: string): { key: string; fingerprint: string } {
  const valid = validateConfig(config);
  const fingerprint = digest(JSON.stringify(valid));
  return { key: `calendar:${digest(JSON.stringify([username, valid.semester, fingerprint]))}`, fingerprint };
}

function readSnapshot(value: string | null, fingerprint: string, now: number): Snapshot | null {
  try {
    const s = JSON.parse(value ?? 'null') as Snapshot | null;
    if (!s || s.fingerprint !== fingerprint || typeof s.ics !== 'string' || typeof s.generatedAt !== 'string') return null;
    const timestamp = Date.parse(s.generatedAt);
    if (!Number.isFinite(timestamp) || timestamp > now || !s.ics.startsWith('BEGIN:VCALENDAR\r\n') || !s.ics.endsWith('END:VCALENDAR\r\n')) return null;
    return s;
  } catch { return null; }
}

function respond(snapshot: Snapshot, status: 'fresh' | 'stale'): Response {
  return new Response(snapshot.ics, { headers: {
    'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, no-store',
    'last-modified': new Date(snapshot.generatedAt).toUTCString(), 'x-calendar-status': status,
    'x-content-type-options': 'nosniff',
  } });
}

export function createWorker(config: unknown, dependencies: {
  fetch?: Fetch; now?: () => Date; generate?: typeof generateCalendar; log?: Logger;
} = {}) {
  const now = dependencies.now ?? (() => new Date());
  const generate = dependencies.generate ?? generateCalendar;
  const logger = dependencies.log ?? logRecord;
  const pending = new Map<string, Promise<Snapshot>>();
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const unavailable = () => new Response('Calendar unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '300' } });
      const token = env.CALENDAR_TOKEN;
      if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return unavailable();
      const candidate = /^\/calendar\/([A-Za-z0-9_-]+)\.ics$/.exec(new URL(request.url).pathname)?.[1] ?? '';
      if (!timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(candidate).digest())) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
      const started = now().getTime();
      let identity: ReturnType<typeof cacheIdentity>;
      let valid: CalendarConfig;
      try {
        if (!env.PKU_USERNAME?.trim() || !env.PKU_PASSWORD || !env.CALENDAR_KV) throw new Error();
        valid = configWithPrivateConfirmations(config, env.PKU_UNSCHEDULED_COURSES);
        identity = cacheIdentity(valid, env.PKU_USERNAME);
      } catch {
        logger({ stage: 'configuration', category: 'invalid', durationMs: 0 });
        return unavailable();
      }
      const { key, fingerprint } = identity;
      let cached: Snapshot | null = null;
      try {
        cached = readSnapshot(await env.CALENDAR_KV.get(key), fingerprint, started);
        if (cached) {
          try { assertGenerationAllowed(valid, new Date(cached.generatedAt)); }
          catch { cached = null; }
        }
      }
      catch { logger({ stage: 'cache', category: 'read_failed', durationMs: now().getTime() - started }); }
      // The binding limits generation, not retention of a previously valid snapshot.
      // Check even a young snapshot: freshness must not extend the generation window.
      try { assertGenerationAllowed(valid, now()); }
      catch (error) {
        logger({ stage: 'generate', category: errorCategory(error), durationMs: now().getTime() - started });
        return cached ? respond(cached, 'stale') : unavailable();
      }
      if (cached && started - Date.parse(cached.generatedAt) < REFRESH_MS) return respond(cached, 'fresh');
      // Keep persistence identity independent of secrets, but do not join an old-password refresh.
      const flightKey = `${key}:${digest(env.PKU_PASSWORD)}`;
      try {
        let refresh = pending.get(flightKey);
        if (!refresh) {
          refresh = (async () => {
            const result = await generate(valid, { username: env.PKU_USERNAME!, password: env.PKU_PASSWORD! }, { fetch: dependencies.fetch ?? fetch, now });
            assertGenerationAllowed(valid, now());
            const snapshot: Snapshot = { ...result, fingerprint };
            await env.CALENDAR_KV.put(key, JSON.stringify(snapshot));
            logger({ stage: 'generate', category: 'success', durationMs: now().getTime() - started });
            return snapshot;
          })();
          pending.set(flightKey, refresh);
          // Clear only the promise this request installed, including on rejection.
          void refresh.finally(() => { if (pending.get(flightKey) === refresh) pending.delete(flightKey); }).catch(() => {});
        }
        return respond(await refresh, 'fresh');
      } catch (error) {
        logger({ stage: 'generate', category: errorCategory(error), durationMs: now().getTime() - started });
        return cached ? respond(cached, 'stale') : unavailable();
      }
    },
  };
}
