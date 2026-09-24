import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { calendarIdentity } from '../calendar/compare.js';

export class WorkerSetupError extends Error {}
export type WorkerCommand = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;

/** Wrangler can log stdout (including auth tokens) to disk: keep all logs in the private run directory. */
export function workerCommand(directory: string, parent: NodeJS.ProcessEnv = process.env): WorkerCommand {
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  return (args, extra = {}) => new Promise((resolveResult, reject) => {
    const env = workerCommandEnv(parent, directory, extra);
    const child = execFile(process.execPath, [cli, ...args], {
      env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) reject(new WorkerSetupError('Wrangler 命令失败或超时；请检查登录、账号权限和网络后重试。'));
      else resolveResult(stdout.trim());
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

export function workerCommandEnv(parent: NodeJS.ProcessEnv, directory: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PKU_') || key.startsWith('WRANGLER_') || key.startsWith('CLOUDFLARE_')
      || key.startsWith('CF_') || ['CALENDAR_TOKEN', 'PAGES_CALENDAR_TOKEN', 'PAGES_CALENDAR_SNAPSHOT', 'DEBUG', 'NODE_DEBUG', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  // Only documented authentication inputs are inherited. Deployment always pins the account.
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL']) {
    if (parent[key]) env[key] = parent[key];
  }
  // Wrangler emits auth-token and KV-list JSON at `log`; `info` suppresses that output.
  return { ...env, ...extra, CI: 'true', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: resolve(directory, 'logs'), WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };
}

/** Fixed origin, no redirects, bounded requests, and no raw API errors in output. */
export function cloudflareReader(token: string, account: string, request: typeof fetch) {
  return async (path: string, missing = false): Promise<unknown | null> => {
    try {
      const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (missing && response.status === 404) return null;
      if (!response.ok) throw new WorkerSetupError(`Cloudflare 配置查询失败（HTTP ${response.status}）；请检查账号权限和网络。`);
      const body = z.object({ success: z.literal(true), result: z.unknown() }).parse(await response.json());
      if (body.result === null || body.result === undefined) throw new Error();
      return body.result;
    } catch (error) {
      if (error instanceof WorkerSetupError) throw error;
      throw new WorkerSetupError('Cloudflare 配置查询失败；请检查登录、网络和 API 响应。');
    }
  };
}

/** Never log the URL, response body, or underlying fetch error. */
export async function verifyWorker(url: string, request: typeof fetch, sleep: (ms: number) => Promise<unknown>, expectedIcs: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' });
      if (response.status === 200 && response.headers.get('content-type')?.split(';')[0]?.trim() === 'text/calendar'
        && response.headers.get('cache-control')?.includes('no-store')
        && Number.isFinite(Date.parse(response.headers.get('last-modified') ?? ''))) {
        if (calendarIdentity(await response.text()) !== calendarIdentity(expectedIcs)) throw new Error();
        const invalid = new URL(url);
        invalid.pathname = '/calendar/invalid.ics';
        const denied = await request(invalid.href, { redirect: 'error', signal: AbortSignal.timeout(30_000), cache: 'no-store' });
        if (denied.status === 404) return;
      }
    } catch { /* Propagation, transient upstream failures, and malformed calendars are all unverified. */ }
    if (attempt < 5) await sleep(5_000);
  }
  throw new WorkerSetupError('代码已部署，但云端日历验证未通过（需与本次快照一致的 ICS 和错误令牌 404）。请检查云端配置与网络后重试；已部署资源保留。');
}
