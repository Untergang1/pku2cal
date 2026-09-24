import { supplements } from '../fixtures/supplements.js';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { setupWorker, withWorkerSetupDirectory, type WorkerSetupDependencies } from '../../src/entrypoints/worker-setup.js';
import { cloudflareReader, verifyWorker, workerCommand, workerCommandEnv } from '../../src/entrypoints/worker-cloudflare.js';
import { saveWorkerFile, workerState } from '../../src/entrypoints/worker-state.js';

const account = 'a'.repeat(32);
const namespace = 'b'.repeat(32);
const token = Buffer.alloc(32, 1).toString('base64url');
const rotated = Buffer.alloc(32, 2).toString('base64url');
const statePath = `data/worker/${account}/pku2cal.json`;
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic//EN\r\nEND:VCALENDAR\r\n';
const config = JSON.parse(await readFile(new URL('../../config/pku-main-2026-2027-1.json', import.meta.url), 'utf8'));
config.semesterBinding = { confirmedSemester: '2026-2027-1', validFrom: '2026-09-07', validThrough: '2027-01-10' };
const wrangler = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8'));
const bindings = [
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
    env: { PKU_USERNAME: 'synthetic-user', PKU_PASSWORD: 'synthetic-password' },
    read: async path => {
      if (path === 'wrangler.jsonc') return JSON.stringify(wrangler);
      if (path === resolve('config/calendar.json')) return JSON.stringify(config);
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

it('creates a Worker with a persistent independent token, JSON secrets, pinned account, and verified URL', async () => {
  const f = fixture();
  f.d.env.PKU_UNSCHEDULED_COURSES_FILE = 'data/synthetic-confirmations.json';
  const decisions = [{ semester: '2026-2027-1', courseId: 'SYN002', classId: '01', confirmed: true, expectedSegments: ['(synthetic)'] }];
  f.files.set(resolve('data/synthetic-confirmations.json'), JSON.stringify(decisions));
  const url = await setupWorker({ deploy: true }, f.d);
  expect(url).toBe(`https://pku2cal.synthetic.workers.dev/calendar/${token}.ics`);
  expect(f.uploaded()).toEqual({ PKU_USERNAME: 'synthetic-user', PKU_PASSWORD: 'synthetic-password', CALENDAR_TOKEN: token, PKU_UNSCHEDULED_COURSES: JSON.stringify(decisions), PKU_COURSE_SUPPLEMENTS: 'null' });
  expect(workerState.parse(JSON.parse(f.files.get(statePath)!)).namespaceId).toBe(namespace);
  const config = JSON.parse(f.files.get(`data/worker/${account}/pku2cal.wrangler.json`)!);
  expect(config).toMatchObject({ account_id: account, workers_dev: true, preview_urls: false, kv_namespaces: [{ binding: 'CALENDAR_KV', id: namespace }], observability: { enabled: false } });
  expect(config.main).toBe(resolve('dist/worker.mjs'));
  expect(config.build.cwd).toBe(resolve('.'));
  expect(f.files.has(resolve(f.d.directory, 'secrets.json'))).toBe(false);
  expect(f.logs.join('\n')).not.toMatch(/synthetic-password|synthetic-user|synthetic-cloudflare-token|calendar\/|expectedSegments/);
  expect(JSON.stringify(f.calls.map(c => c.args))).not.toContain(token);
  expect(f.requests.every(r => r.options?.redirect === 'error' && !!r.options.signal)).toBe(true);
});

it('reuses KV and token on repeated runs, and clears old course confirmations with []', async () => {
  const f = fixture();
  const first = await setupWorker({ deploy: true }, f.d);
  f.d.randomToken = () => { throw new Error('must not rotate'); };
  expect(await setupWorker({ deploy: true }, f.d)).toBe(first);
  expect(f.calls.filter(c => c.args[2] === 'create')).toHaveLength(1);
  expect(f.uploaded()?.PKU_UNSCHEDULED_COURSES).toBe('[]');
});

it('requires --deploy and refuses CI before running commands', async () => {
  const f = fixture();
  await expect(setupWorker({ deploy: false }, f.d)).rejects.toThrow('--deploy');
  f.d.env.CI = 'true';
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('本机');
  expect(f.calls).toEqual([]);
});

it.each(['credentials', 'expired', 'confirmations', 'timetable', 'public-private', 'jsonc'])('stops invalid local %s before remote work', async kind => {
  const f = fixture();
  if (kind === 'credentials') delete f.d.env.PKU_PASSWORD;
  if (kind === 'expired') f.d.now = () => new Date('2027-01-11T00:00:00Z');
  if (kind === 'confirmations') { f.d.env.PKU_UNSCHEDULED_COURSES_FILE = 'private'; f.d.env.PKU_UNSCHEDULED_COURSES = '[]'; }
  const original = f.d.read;
  f.d.read = async path => {
    if (kind === 'timetable' && path.endsWith('/pku-main.json')) return '{}';
    if (kind === 'public-private' && path === resolve('config/calendar.json')) return JSON.stringify({ ...config, unscheduledCourses: [] });
    if (kind === 'jsonc' && path === 'wrangler.jsonc') return '{';
    return original(path);
  };
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

it.each(['--dry-run', 'whoami', 'auth token', 'namespace list'])('fails safely when %s fails', async failCommand => {
  const f = fixture();
  f.cloud.failCommand = failCommand;
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('Worker 初始化失败');
  expect(f.writes()).toEqual([]);
  expect(f.logs.join(' ')).not.toContain('synthetic-password');
});

it('supports JSONC and a custom calendar path without loading private data into the build', async () => {
  const f = fixture();
  f.d.env.PKU_CONFIG_PATH = 'data/synthetic-calendar.json';
  const read = f.d.read;
  f.d.read = async path => path === 'wrangler.jsonc' ? `// comment\n${JSON.stringify(wrangler)}`
    : path === resolve(f.d.env.PKU_CONFIG_PATH!) ? JSON.stringify(config) : read(path);
  await setupWorker({ deploy: true }, f.d);
  expect(f.calls[0]!.env).toEqual({ PKU_CONFIG_PATH: resolve('data/synthetic-calendar.json') });
});

it('requires explicit selection for multiple accounts and rejects inaccessible accounts', async () => {
  const f = fixture();
  f.cloud.accounts.push({ id: 'c'.repeat(32) });
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('--account');
  await expect(setupWorker({ deploy: true, account: 'd'.repeat(32) }, f.d)).rejects.toThrow('不在');
  expect(f.writes()).toEqual([]);
  await setupWorker({ deploy: true, account }, f.d);
  expect(f.writes().every(c => c.env?.CLOUDFLARE_ACCOUNT_ID === account)).toBe(true);
});

it('refuses an unrelated Worker even with rotation requested', async () => {
  const f = fixture();
  f.cloud.exists = true; f.cloud.bindings = [];
  await expect(setupWorker({ deploy: true, rotateToken: true }, f.d)).rejects.toThrow('同名 Worker');
  expect(f.writes()).toEqual([]);
});

it('requires state recovery or explicit rotation for an existing remote token', async () => {
  const f = fixture(); f.existing(); f.files.delete(statePath);
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('本地状态文件缺失');
  expect(f.writes()).toEqual([]);
  f.d.randomToken = () => rotated;
  expect(await setupWorker({ deploy: true, rotateToken: true }, f.d)).toContain(rotated);
  expect(f.calls.some(c => c.args[2] === 'create')).toBe(false);
});

it.each(['broken', 'account', 'namespace', 'missing-kv', 'unowned-kv'])('does not silently replace state or resources: %s', async kind => {
  const f = fixture(); f.existing();
  if (kind === 'broken') f.files.set(statePath, '{');
  if (kind === 'account') f.files.set(statePath, JSON.stringify({ accountId: 'c'.repeat(32), name: 'pku2cal', token }));
  if (kind === 'namespace') f.files.set(statePath, JSON.stringify({ accountId: account, name: 'pku2cal', token, namespaceId: 'c'.repeat(32) }));
  if (kind === 'missing-kv') f.cloud.namespaces = [];
  if (kind === 'unowned-kv') { f.files.delete(statePath); f.cloud.exists = false; }
  await expect(setupWorker({ deploy: true, rotateToken: true }, f.d)).rejects.toThrow();
  expect(f.writes()).toEqual([]);
});

it('does not mutate remote resources if token persistence fails', async () => {
  const f = fixture(); f.cloud.failSave = statePath;
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow();
  expect(f.writes()).toEqual([]);
});

it('resumes after namespace creation with only the pre-saved token', async () => {
  const f = fixture();
  f.files.set(statePath, JSON.stringify({ accountId: account, name: 'pku2cal', token }));
  f.cloud.namespaces = [{ id: namespace, title: 'pku2cal-CALENDAR_KV' }];
  await setupWorker({ deploy: true }, f.d);
  expect(f.calls.some(c => c.args[2] === 'create')).toBe(false);
});

it('retains a rotated token after deploy failure and cleans temporary secrets before retry', async () => {
  const f = fixture(); f.existing(); f.d.randomToken = () => rotated;
  f.cloud.failCommand = '--secrets-file';
  await expect(setupWorker({ deploy: true, rotateToken: true }, f.d)).rejects.toThrow('部署代码');
  expect(JSON.parse(f.files.get(statePath)!).token).toBe(rotated);
  expect(f.files.has(resolve(f.d.directory, 'secrets.json'))).toBe(false);
  f.cloud.failCommand = '';
  expect(await setupWorker({ deploy: true }, f.d)).toContain(rotated);
});

it.each([401, 403, 500])('does not treat Cloudflare HTTP %s as missing resources', async apiStatus => {
  const f = fixture(); f.cloud.apiStatus = apiStatus;
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow();
  expect(f.writes()).toEqual([]);
});

it('explains missing workers.dev setup before mutations', async () => {
  const f = fixture(); f.cloud.missingSubdomain = true;
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('子域名');
  expect(f.writes()).toEqual([]);
});

it.each(['503', 'malformed', 'stale', 'network', 'wrong-token', 'disabled-route'])('reports deployment separately when cloud verification fails: %s', async kind => {
  const f = fixture();
  if (kind === '503') f.cloud.status = 503;
  if (kind === 'malformed') f.cloud.body = '<html>private response</html>';
  if (kind === 'stale') f.cloud.cacheStatus = 'stale';
  if (kind === 'network') f.cloud.failProbe = true;
  if (kind === 'wrong-token') f.cloud.invalidStatus = 200;
  if (kind === 'disabled-route') f.cloud.routeEnabled = false;
  const failure = await setupWorker({ deploy: true }, f.d).catch(error => error.message as string);
  expect(failure).toContain('已完成部署');
  expect(failure).not.toContain(token);
  expect(failure).not.toContain('private response');
  expect(f.cloud.exists).toBe(true);
  expect(f.files.has(statePath)).toBe(true);
});

it('retries propagation failures without logging private URLs', async () => {
  let count = 0;
  const request = (async (url: string) => ++count === 1 ? new Response('', { status: 404 })
    : url.endsWith('/invalid.ics') ? new Response('', { status: 404 }) : fresh()) as typeof fetch;
  const waits: number[] = [];
  await verifyWorker(`https://test.workers.dev/calendar/${token}.ics`, request, async ms => { waits.push(ms); });
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


it('uploads supplements privately and clears them with null on a later setup', async () => {
  const f = fixture();
  f.d.env.PKU_COURSE_SUPPLEMENTS_FILE = 'data/synthetic-supplements.json';
  f.files.set(resolve('data/synthetic-supplements.json'), JSON.stringify(supplements));
  await setupWorker({ deploy: true }, f.d);
  expect(JSON.parse(f.uploaded()!.PKU_COURSE_SUPPLEMENTS!)).toEqual(supplements);
  expect(f.logs.join('\n')).not.toMatch(/SYN003|合成单周课程|手动教室/);
  expect(f.files.get(`data/worker/${account}/pku2cal.wrangler.json`)).not.toContain('SYN003');
  delete f.d.env.PKU_COURSE_SUPPLEMENTS_FILE;
  await setupWorker({ deploy: true }, f.d);
  expect(f.uploaded()?.PKU_COURSE_SUPPLEMENTS).toBe('null');
});

it('rejects competing supplement sources before invoking Wrangler or Cloudflare', async () => {
  const f = fixture();
  f.d.env.PKU_COURSE_SUPPLEMENTS = JSON.stringify(supplements);
  f.d.env.PKU_COURSE_SUPPLEMENTS_FILE = 'data/synthetic-supplements.json';
  await expect(setupWorker({ deploy: true }, f.d)).rejects.toThrow('本地配置');
  expect(f.calls).toEqual([]);
  expect(f.requests).toEqual([]);
});
