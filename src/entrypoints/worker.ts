import { createHash, timingSafeEqual } from 'node:crypto';
import type { GeneratedCalendar } from '../application/generate.js';

export interface WorkerEnv { CALENDAR_TOKEN?: string }
/** The deployed snapshot is immutable; requests never access upstream services or storage. */
export function createWorker(snapshot: GeneratedCalendar) {
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const unavailable = () => new Response('Calendar unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
      const token = env.CALENDAR_TOKEN;
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return unavailable();
      const candidate = /^\/calendar\/([A-Za-z0-9_-]+)\.ics$/.exec(new URL(request.url).pathname)?.[1] ?? '';
      if (!timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(candidate).digest())) {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
      if (!snapshot || typeof snapshot.ics !== 'string' || !snapshot.ics.startsWith('BEGIN:VCALENDAR\r\n')
        || !snapshot.ics.endsWith('END:VCALENDAR\r\n') || !Number.isFinite(Date.parse(snapshot.generatedAt))) return unavailable();
      return new Response(snapshot.ics, { headers: {
        'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, no-store',
        'last-modified': new Date(snapshot.generatedAt).toUTCString(), 'x-content-type-options': 'nosniff',
      } });
    },
  };
}
