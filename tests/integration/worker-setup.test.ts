import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { setupWorker, withWorkerSetupDirectory, type WorkerSetupDependencies } from '../../src/entrypoints/worker-setup.js';
import { cloudflareReader, verifyWorker, workerCommand, workerCommandEnv } from '../../src/entrypoints/worker-cloudflare.js';
import { saveWorkerFile } from '../../src/entrypoints/worker-state.js';

const account = 'a'.repeat(32);
const namespace = 'b'.repeat(32);
const token = Buffer.alloc(32, 1).toString('base64url');
const rotated = Buffer.alloc(32, 2).toString('base64url');
const statePath = `data/worker/${account}/pku2cal.json`;
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//EN\r\nEND:VCALENDAR\r\n';
const config = JSON.parse(await readFile(new URL('../../config/pku-main-2026-2027-1.json', import.meta.url), 'utf8'));
config.semesterBinding = { confirmedSemester: '2026-2027-1', validFrom: '2026-09-07', validThrough: '2027-01-10' };
const wrangler = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
const bindings: { name: string; type: string; namespace_id?: string; text?: string }[] = [
  { name: 'CALENDAR_KV', type: 'kv_namespace', namespace_id: namespace },
  ...['PKU_USERNAME', 'PKU_PASSWORD', 'CALENDAR_TOKEN'].map(name => ({ name, type: 'secret_text' })),
];
const fresh = (body = ics, status = 'fresh') => new Response(body, { headers: {
  'content-type': 'text/calendar; charset=utf-8', 'x-calendar-status': status,
  'cache-control': 'private, no-store', 'last-modified': 'Thu, 24 Sep 2026 00:00:00 GMT',
} });

function fixture() {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const cloud = {
    exists: false, bindings, accounts: [{ id: account }], namespaces: [] as { id: string; title: string }[],
    failCommand: '', status: 200, body: ics, cacheStatus: 'fresh', apiStatus: 200, failSave: '',
    missingSubdomain: false, routeEnabled: true, failProbe: false, invalidStatus: 404,
  };
  let uploaded: Record<string, string> | undefined;
  const d: WorkerSetupDependencies = {
    directory: resolve('.cache/synthetic-worker-setup'),
    env: {},
    read: async path => {
      if (path === 'wrangler.jsonc') return JSON.stringify(wrangler);
      if (path === 'data/schedule.yaml') return JSON.stringify({ version: 1, semester: '2026-2027-1', courses: [] });
      if (path === 'config/calendar.json') return JSON.stringify(config);
      if (path.endsWith('/config/timetables/pku-main.json')) return readFile(path, 'utf8');
      if (files.has(path)) return files.get(path)!;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    save: async (path, content) => {
      if (cloud.failSave === path) throw new Error('private filesystem error');
      files.set(path, content);
    },
    remove: async path => { files.delete(path); },
    randomToken: () => token, now: () => new Date('2026-09-24T00:00:00Z'),
    sleep: async () => {}, log: message => logs.push(message),
    command: async (args, env) => {
      calls.push({ args, env });
      if (args.join(' ').includes(cloud.failCommand) && cloud.failCommand) throw new Error('synthetic-password private CLI failure');
      if (args[0] === 'whoami') return JSON.stringify({ loggedIn: true, accounts: cloud.accounts });
      if (args[0] === 'auth') return JSON.stringify({ type: 'oauth', token: 'synthetic-cloudflare-token' });
      if (args[0] === 'kv' && args[2] === 'list') return JSON.stringify(cloud.namespaces);
      if (args[0] === 'kv' && args[2] === 'create') {
        expect(files.has(statePath)).toBe(true);
        cloud.namespaces.push({ id: namespace, title: args[3]! });
      }
      if (args[0] === 'deploy' && !args.includes('--dry-run')) {
        uploaded = JSON.parse(files.get(args[args.indexOf('--secrets-file') + 1]!)!);
        cloud.exists = true;
        cloud.bindings = [{ name: 'PKU2CAL_MODE', type: 'plain_text', text: 'snapshot-v1' }, { name: 'CALENDAR_TOKEN', type: 'secret_text' }];
        cloud.body = JSON.parse(files.get(env!.PKU_SNAPSHOT_PATH!)!).ics;
      }
      return '';
    },
    fetch: (async (input: string | URL | Request, options?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, options });
      if (url.startsWith('https://api.cloudflare.com/')) {
        expect(options?.headers).toEqual({ authorization: 'Bearer synthetic-cloudflare-token' });
        if (cloud.apiStatus !== 200) return new Response('private Cloudflare response', { status: cloud.apiStatus });
        if (url.endsWith('/settings')) return cloud.exists ? Response.json({ success: true, result: { bindings: cloud.bindings } }) : new Response('', { status: 404 });
        if (url.endsWith('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: cloud.missingSubdomain ? '' : 'synthetic' } });
        if (url.endsWith('/subdomain')) return Response.json({ success: true, result: { enabled: cloud.routeEnabled } });
        throw new Error('Unexpected API request');
      }
      if (cloud.failProbe) throw new Error(`private URL ${url}`);
      if (url.endsWith('/invalid.ics')) return new Response('', { status: cloud.invalidStatus });
      return cloud.status === 200 ? fresh(cloud.body, cloud.cacheStatus) : new Response('private course error', { status: cloud.status });
    }) as typeof fetch,
  };
  const existing = () => {
    cloud.exists = true;
    cloud.namespaces = [{ id: namespace, title: 'pku2cal-CALENDAR_KV' }];
    files.set(statePath, JSON.stringify({ accountId: account, name: 'pku2cal', token, namespaceId: namespace }));
  };
  const writes = () => calls.filter(item => item.args[2] === 'create' || item.args[0] === 'deploy' && !item.args.includes('--dry-run'));
  return { d, files, cloud, calls, requests, logs, existing, writes, uploaded: () => uploaded };
}

it('retries propagation failures without logging private URLs', async () => {
  let count = 0;
  const request = (async (url: string) => ++count === 1 ? new Response('', { status: 404 })
    : url.endsWith('/invalid.ics') ? new Response('', { status: 404 }) : fresh()) as typeof fetch;
  const waits: number[] = [];
  await verifyWorker(`https://test.workers.dev/calendar/${token}.ics`, request, async ms => { waits.push(ms); }, ics);
  expect(waits).toEqual([5000]);
});

it('sanitizes child environments and pins account/auth without leaking PKU or Pages secrets', () => {
  const env = workerCommandEnv({ PKU_USERNAME: 'private', PKU_PASSWORD: 'private', PAGES_CALENDAR_TOKEN: token,
    CALENDAR_TOKEN: token, CLOUDFLARE_ENV: 'production', CLOUDFLARE_API_BASE_URL: 'https://example.com',
    WRANGLER_LOG_SANITIZE: 'false', WRANGLER_LOG: 'debug', NODE_OPTIONS: '--inspect', DEBUG: '*',
    CLOUDFLARE_API_TOKEN: 'cf-token', PATH: '/synthetic/bin' }, '/private/run', { CLOUDFLARE_ACCOUNT_ID: account });
  expect(env).toMatchObject({ PATH: '/synthetic/bin', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'cf-token', WRANGLER_LOG_SANITIZE: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });
  for (const key of ['PKU_PASSWORD', 'PKU_USERNAME', 'PAGES_CALENDAR_TOKEN', 'CALENDAR_TOKEN', 'CLOUDFLARE_ENV', 'CLOUDFLARE_API_BASE_URL', 'NODE_OPTIONS', 'DEBUG']) expect(env[key]).toBeUndefined();
  expect(env.WRANGLER_LOG_PATH).toBe('/private/run/logs');
});

it('suppresses API bodies, redirects and network errors while preserving HTTP status', async () => {
  const request = (async () => new Response('synthetic-private-password', { status: 403 })) as typeof fetch;
  await expect(cloudflareReader('private', account, request)('/workers/subdomain')).rejects.toThrow('HTTP 403');
  const broken = (async () => { throw new Error('synthetic-private-password'); }) as typeof fetch;
  await expect(cloudflareReader('private', account, broken)('/workers/subdomain')).rejects.not.toThrow('synthetic-private-password');
});

it('preserves real Wrangler auth JSON output with a synthetic token and no Cloudflare requests', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'pku2cal-worker-auth-'));
  try {
    const configPath = resolve(directory, 'wrangler.json');
    await saveWorkerFile(configPath, JSON.stringify({ name: 'synthetic-worker', compatibility_date: '2026-09-24' }));
    const command = workerCommand(directory, { CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token' });
    const output = await command(['auth', 'token', '--json', '--config', configPath]);
    expect(JSON.parse(output)).toEqual({ type: 'api_token', token: 'synthetic-cloudflare-token' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([null, undefined])('does not mistake a successful but empty API result for a missing Worker: %s', async result => {
  const request = (async () => Response.json({ success: true, result })) as typeof fetch;
  await expect(cloudflareReader('private', account, request)('/workers/scripts/pku2cal/settings', true)).rejects.toThrow();
});

it('blocks concurrent local setup and cleans secrets, logs and lock after failure', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'pku2cal-worker-run-'));
  try {
    await expect(withWorkerSetupDirectory(async directory => {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      await saveWorkerFile(resolve(directory, 'secrets.json'), 'synthetic-password');
      await saveWorkerFile(resolve(directory, 'logs', 'wrangler.log'), 'synthetic-token');
      await expect(withWorkerSetupDirectory(async () => { throw new Error('must not run'); }, root)).rejects.toThrow('另一个初始化');
      throw new Error('deployment failed');
    }, root)).rejects.toThrow('deployment failed');
    expect(await readdir(root)).toEqual([]);
    expect(await withWorkerSetupDirectory(async () => 'retry', root)).toBe('retry');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('persists private state atomically with 0600 permissions and no temporary residue', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'pku2cal-worker-state-'));
  try {
    const path = resolve(directory, 'state.json');
    await saveWorkerFile(path, 'first');
    await saveWorkerFile(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['state.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('deploys an offline embedded snapshot with only a token and no KV', async () => {
  const f = fixture();
  expect(await setupWorker({ deploy: true }, f.d)).toContain(token);
  expect(f.uploaded()).toEqual({ CALENDAR_TOKEN: token });
  expect(f.calls.some(c => c.args[0] === 'kv')).toBe(false);
  const config = JSON.parse(f.files.get(`data/worker/${account}/pku2cal.wrangler.json`)!);
  expect(config.kv_namespaces).toBeUndefined();
  expect(config.vars).toEqual({ PKU2CAL_MODE: 'snapshot-v1' });
  expect(f.files.has(resolve(f.d.directory, 'secrets.json'))).toBe(false);
  expect(await setupWorker({ deploy: true }, f.d)).toContain(token);
});
it('migrates existing deployment state and preserves the URL without deleting KV', async () => {
  const f = fixture(); f.existing();
  await setupWorker({ deploy: true }, f.d);
  expect(JSON.parse(f.files.get(statePath)!)).toEqual({ accountId: account, name: 'pku2cal', token });
  expect(JSON.parse(f.files.get(`${statePath}.pre-snapshot.bak`)!).namespaceId).toBe(namespace);
  expect(f.calls.filter(c => c.args[0] === 'secret').map(c => c.args[2])).toEqual(['PKU_USERNAME', 'PKU_PASSWORD']);
  expect(f.calls.some(c => c.args[0] === 'kv')).toBe(false);
});
it.each(['missing-yaml', 'unknown-worker', 'missing-state', 'invalid-state', 'kv-conflict', 'missing-account'])('stops before deployment for %s', async kind => {
  const f = fixture();
  if (kind === 'missing-yaml') { const read = f.d.read; f.d.read = path => path === 'data/schedule.yaml' ? Promise.reject(new Error()) : read(path); }
  else {
    f.existing();
    if (kind === 'unknown-worker') f.cloud.bindings = [];
    if (kind === 'missing-state') f.files.delete(statePath);
    if (kind === 'invalid-state') f.files.set(statePath, 'broken');
    if (kind === 'kv-conflict') f.files.set(statePath, JSON.stringify({ accountId: account, name: 'pku2cal', token, namespaceId: 'd'.repeat(32) }));
    if (kind === 'missing-account') f.cloud.accounts.push({ id: 'd'.repeat(32) });
  }
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow();
  expect(f.writes()).toEqual([]);
});
it('keeps a newly rotated token on deploy failure and reuses it on retry', async () => {
  const f = fixture(); f.existing();
  f.d.randomToken = () => rotated;
  f.cloud.failCommand = '--secrets-file';
  await expect(setupWorker({ deploy: true, rotateToken: true }, f.d)).rejects.toThrow();
  expect(JSON.parse(f.files.get(statePath)!).token).toBe(rotated);
  f.cloud.failCommand = '';
  expect(await setupWorker({ deploy: true }, f.d)).toContain(rotated);
  expect(JSON.parse(f.files.get(`${statePath}.pre-snapshot.bak`)!).token).toBe(token);
});
it('reports old secret cleanup failures after verified deployment', async () => {
  const f = fixture(); f.existing(); f.cloud.failCommand = 'secret delete';
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('发布成功、旧 Secrets 清理未完成');
  expect(f.writes()).toHaveLength(1);
});
it('rejects an unrelated valid calendar during deployment verification', async () => {
  const f = fixture(); f.cloud.failProbe = true;
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('已完成部署');
  await expect(verifyWorker(`https://test.workers.dev/calendar/${token}.ics`, (async url => String(url).endsWith('/invalid.ics')
    ? new Response('', { status: 404 }) : fresh(ics.replace('Synthetic', 'Other'))), async () => {}, ics)).rejects.toThrow('验证未通过');
});
it('requires local interactive deployment and refuses CI', async () => {
  const f = fixture();
  await expect(setupWorker({ deploy: false }, f.d)).rejects.toThrow('worker:deploy');
  f.d.env.CI = 'true';
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('本机');
  expect(f.calls).toEqual([]);
});
