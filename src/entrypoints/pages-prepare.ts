import { appendFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calendarIdentity } from '../calendar/compare.js';
import type { GeneratedCalendar } from '../application/generate.js';
import { decodeSnapshot } from '../application/snapshot.js';
import { savePagesState, subscriptionUrl, validatePagesToken } from './pages-state.js';

export interface PagesDecision { changed: boolean; reason: 'missing' | 'changed' | 'unchanged' | 'forced' }

export async function preparePages(options: {
  token: string; baseUrl: string; force: boolean; directory: string;
  snapshot: GeneratedCalendar; fetch: typeof fetch;
}): Promise<PagesDecision> {
  const url = subscriptionUrl(options.baseUrl, options.token);
  const candidate = options.snapshot;
  const identity = calendarIdentity(candidate.ics);
  let reason: PagesDecision['reason'] = 'forced';
  if (!options.force) {
    try {
      const response = await options.fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
      if (response.status === 404) reason = 'missing';
      else if (response.status === 200) reason = calendarIdentity(await response.text()) === identity ? 'unchanged' : 'changed';
      else throw new Error();
    } catch {
      // Fetch errors may contain the entire private URL or upstream response body.
      throw new Error('pages:comparison_failed');
    }
  }
  if (reason === 'unchanged') return { changed: false, reason };
  // This is a dedicated, ignored staging directory, never an existing deployment.
  await rm(options.directory, { recursive: true, force: true });
  await mkdir(options.directory, { recursive: true });
  await savePagesState(resolve(options.directory, options.token, 'calendar.ics'), candidate.ics);
  return { changed: true, reason };
}

export async function main(): Promise<void> {
  try {
    const snapshot = decodeSnapshot(process.env.PAGES_CALENDAR_SNAPSHOT ?? '', process.env.PAGES_SNAPSHOT_ID ?? '');
    const token = validatePagesToken(snapshot.token);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
    const force = process.env.PAGES_FORCE_PUBLISH ?? 'false';
    if (!['true', 'false'].includes(force)) throw new Error();
    const decision = await preparePages({ token, baseUrl: process.env.PAGES_BASE_URL ?? '', force: force === 'true',
      directory: resolve('site'), snapshot, fetch });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${decision.changed}\nreason=${decision.reason}\n`);
    console.log(`Pages check: ${decision.reason}`);
  } catch (error) {
    console.error('Pages 快照检查失败：请检查快照大小、摘要、令牌与线上响应；本次未上传或部署。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
