import { decodeSnapshot } from '../../src/application/snapshot.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { command, parseApiResponse, repositoryFromOrigin, setupPages, type CommandResult, type PagesDependencies } from '../../src/entrypoints/pages-setup.js';

const token = Buffer.alloc(32, 1).toString('base64url');
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const config = JSON.parse(await readFile(new URL('../../config/pku-main-2026-2027-1.json', import.meta.url), 'utf8'));
config.timetable = 'pku-main'; // This fixture uses an invalid pku-ss table to test validation.
config.semesterBinding = { confirmedSemester: '2026-2027-1', validFrom: '2026-09-07', validThrough: '2027-01-10' };
const response = (data: unknown, status = 200): CommandResult => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} Test\r\nContent-Type: application/json\r\n\r\n${data === null ? '' : JSON.stringify(data)}`,
});

function fixture(options: {
  pages?: 'missing' | 'legacy' | 'workflow'; failPath?: string; failStatus?: number;
  dirty?: boolean; remoteSha?: string; changedSha?: boolean; conclusion?: string;
  unchanged?: boolean; remoteToken?: boolean; localToken?: string;
  selectedTimetable?: 'pku-main' | 'pku-ss';
  skipped?: boolean; wait?: boolean; runSha?: string; dispatchId?: boolean; secretsFail?: boolean;
} = {}) {
  const calls: { program: string; args: string[]; input: string | undefined }[] = [];
  const logs: string[] = [];
  const saved = new Map<string, string>();
  if (options.localToken) saved.set('data/pages/calendar-owner/calendar.json', JSON.stringify({ repository: 'calendar-owner/calendar', token: options.localToken }));
  let clock = Date.parse('2026-09-24T00:00:00Z');
  let reads = 0;
  let pagesRead = 0;
  const d: PagesDependencies = {
    env: {},
    read: async path => {
      if (path === 'data/schedule.yaml') return JSON.stringify({ version: 1, semester: '2026-2027-1', courses: [] });
      if (path === 'config/calendar.json') return JSON.stringify({ ...config, timetable: options.selectedTimetable ?? config.timetable });
      for (const id of ['pku-main', 'pku-ss']) {
        const file = new URL(`../../config/timetables/${id}.json`, import.meta.url);
        if (path === fileURLToPath(file)) return id === 'pku-ss' ? JSON.stringify({ label: '合成软微草稿', periods: [] }) : readFile(file, 'utf8');
      }
      if (saved.has(path)) return saved.get(path)!;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    save: async (path, content) => { saved.set(path, content); }, randomToken: () => token,
    now: () => new Date(clock), sleep: async () => { clock += 5 * 60_000; }, log: value => logs.push(value),
    command: async (program, args, input) => {
      calls.push({ program, args, input });
      if (program === 'git') {
        const key = args.join(' ');
        const output: Record<string, string> = {
          'rev-parse --show-prefix': '',
          'status --porcelain --untracked-files=normal': options.dirty ? ' M package.json' : '',
          'remote get-url origin': 'git@github.com:calendar-owner/calendar.git',
          'remote get-url --push origin': 'git@github.com:calendar-owner/calendar.git',
          'rev-parse HEAD': sha,
          'ls-files --error-unmatch config/timetables/pku-main.json': 'config/timetables/pku-main.json',
          'ls-files --error-unmatch .github/workflows/pages.yml': 'config/calendar.json\n.github/workflows/pages.yml',
        };
        if (!(key in output)) throw new Error(`Unexpected git command: ${key}`);
        return { code: 0, stdout: output[key]! };
      }
      if (program !== 'gh') throw new Error('Unexpected program');
      if (args[0] === 'api') {
        const path = args[1]!.replace('repos/calendar-owner/calendar', '');
        const method = args[args.indexOf('--method') + 1];
        if (path === options.failPath) return response({ message: 'private upstream error' }, options.failStatus ?? 403);
        if (method !== 'GET') {
          if (path.endsWith('/dispatches')) return response(options.dispatchId === false ? null : { workflow_run_id: 123 });
          return response(null, method === 'POST' ? 201 : 204);
        }
        switch (path) {
          case '': return response({ default_branch: 'main', archived: false, permissions: { push: true } });
          case '/commits/main': return response({ sha: ++reads > 1 && options.changedSha ? otherSha : options.remoteSha ?? sha });
          case '/actions/secrets/PAGES_CALENDAR_SNAPSHOT': return options.remoteToken ? response({ name: 'PAGES_CALENDAR_SNAPSHOT' }) : response(null, 404);
          case '/actions/workflows/pages.yml': return response({ state: 'disabled_manually' });
          case '/pages':
            if (++pagesRead === 1 && (options.pages ?? 'missing') === 'missing') return response({ message: 'Not Found' }, 404);
            return response({ build_type: pagesRead > 1 ? 'workflow' : options.pages ?? 'workflow', html_url: 'https://calendar-owner.github.io/calendar/' });
          case '/actions/runs/123': return response({ head_sha: options.runSha ?? sha,
            status: options.wait ? 'queued' : 'completed', conclusion: options.conclusion ?? 'success' });
          case '/actions/runs/123/jobs?per_page=100': return response({ jobs: [
            { name: 'generate', conclusion: 'success', steps: [{ name: 'Calendar unchanged', conclusion: options.unchanged ? 'success' : 'skipped' }] }, { name: 'deploy', conclusion: options.skipped || options.unchanged ? 'skipped' : 'success' },
          ] });
          default: throw new Error(`Unexpected API path: ${path}`);
        }
      }
      if (options.secretsFail && args[0] === 'secret') return { code: 1, stdout: 'synthetic-password' };
      return { code: 0, stdout: '' };
    },
  };
  const writes = () => calls.filter(c => c.program === 'gh' && (
    ['secret', 'variable'].includes(c.args[0]!) || c.args[0] === 'api' && c.args[c.args.indexOf('--method') + 1] !== 'GET'
  ));
  return { d, calls, logs, writes, saved };
}

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['git@github.com:person/fork.git', 'person/fork'],
  ['https://github.com/person/fork.git', 'person/fork'],
  ['ssh://git@github.com/person/fork.git', 'person/fork'],
  ['https://github.com/person/fork/', 'person/fork'],
])('resolves the explicit origin %s without gh fork defaults', (origin, expected) => {
  expect(repositoryFromOrigin(origin)).toBe(expected);
});

it.each(['https://secret@github.com/person/repo.git', 'https://example.com/person/repo', 'git@alias:person/repo', 'https://github.com/person/..'])('rejects ambiguous or credential-bearing origin %s', origin => {
  expect(() => repositoryFromOrigin(origin)).toThrow();
});

it('requires explicit publication consent before running any command', async () => {
  const f = fixture();
  await expect(setupPages(false, f.d)).rejects.toThrow('pages:publish');
  expect(f.calls).toEqual([]);
});

it.each([{ dirty: true }, { remoteSha: otherSha }])('does not mutate GitHub when local work is not pushed: %j', async options => {
  const f = fixture(options);
  await expect(setupPages(true, f.d)).rejects.toThrow();
  expect(f.writes()).toEqual([]);
});

it.each(['--version', 'auth'])('stops before mutation when gh %s fails', async action => {
  const f = fixture();
  const original = f.d.command;
  f.d.command = async (program, args, input) => program === 'gh' && args[0] === action
    ? { code: 1, stdout: 'private diagnostic' } : original(program, args, input);
  await expect(setupPages(true, f.d)).rejects.toThrow(action === 'auth' ? 'gh auth login' : '安装');
  expect(f.writes()).toEqual([]);
});

it('rejects different origin fetch/push repositories before contacting GitHub', async () => {
  const f = fixture();
  const original = f.d.command;
  f.d.command = async (program, args, input) => program === 'git' && args.includes('--push')
    ? { code: 0, stdout: 'git@github.com:someone/else.git' } : original(program, args, input);
  await expect(setupPages(true, f.d)).rejects.toThrow('指向不同仓库');
  expect(f.calls.some(c => c.args[0] === 'api')).toBe(false);
});

it('requires a registered remote workflow before uploading anything', async () => {
  const f = fixture({ failPath: '/actions/workflows/pages.yml', failStatus: 404 });
  await expect(setupPages(true, f.d)).rejects.toThrow('HTTP 404');
  expect(f.writes()).toEqual([]);
});

it('rejects missing local YAML before mutation', async () => {
  const f = fixture();
  const read = f.d.read;
  f.d.read = async path => { if (path === 'data/schedule.yaml') throw new Error(); return read(path); };
  await expect(setupPages(true, f.d)).rejects.toThrow('无法读取课表');
  expect(f.writes()).toEqual([]);
});

it('publishes offline after the old import window without credentials', async () => {
  const f = fixture();
  f.d.now = () => new Date('2030-01-01T00:00:00Z');
  expect(await setupPages(true, f.d)).toContain(token);
});

it.each([401, 403, 500])('does not confuse Pages HTTP %s with an absent site', async status => {
  const f = fixture({ failPath: '/pages', failStatus: status });
  await expect(setupPages(true, f.d)).rejects.toThrow(`HTTP ${status}`);
  expect(f.writes()).toEqual([]);
});

it.each(['missing', 'legacy', 'workflow'] as const)('configures a %s Pages site and waits for the exact dispatched run', async pages => {
  const f = fixture({ pages });
  expect(await setupPages(true, f.d)).toBe(`https://calendar-owner.github.io/calendar/${token}/calendar.ics`);
  const siteWrites = f.writes().filter(c => c.args[1]?.endsWith('/pages'));
  expect(siteWrites).toHaveLength(pages === 'workflow' ? 0 : 1);
  if (siteWrites[0]) {
    expect(siteWrites[0].args).toContain(pages === 'missing' ? 'POST' : 'PUT');
    expect(JSON.parse(siteWrites[0].input!)).toEqual({ build_type: 'workflow' });
  }
  const secrets = f.writes().filter(c => c.args[0] === 'secret');
  expect(secrets.map(c => c.args[2])).toEqual(['PAGES_CALENDAR_SNAPSHOT']);
  const dispatch = f.calls.find(c => c.args[1]?.endsWith('/dispatches'))!;
  const decoded = decodeSnapshot(secrets[0]!.input!, JSON.parse(dispatch.input!).inputs.snapshot_id);
  expect(decoded.token).toBe(token);
  expect(decoded.ics).toContain('BEGIN:VCALENDAR');
  for (const c of secrets) expect(c.args).toContain('calendar-owner/calendar');
  expect(f.calls.map(c => c.args.join(' ')).join('\n')).not.toContain('synthetic-password');
  expect(f.logs.join('\n')).not.toMatch(/synthetic-user|synthetic-password|SYN002/);
  const writes = f.writes();
  expect(writes.at(-2)!.args[0]).toBe('variable');
  expect(writes.at(-1)!.args[1]).toContain('/dispatches');
  expect(f.logs).toContain('本次运行：https://github.com/calendar-owner/calendar/actions/runs/123');
});

it('uses the actual custom Pages address without changing its domain settings', async () => {
  const f = fixture({ pages: 'legacy' });
  const original = f.d.command;
  f.d.command = async (program, args, input) => {
    const result = await original(program, args, input);
    if (args[0] === 'api' && args[1]?.endsWith('/pages') && args.includes('GET')) {
      return response({ build_type: 'legacy', html_url: 'https://calendar.example.org/' });
    }
    return result;
  };
  expect(await setupPages(true, f.d)).toBe(`https://calendar.example.org/${token}/calendar.ics`);
  const write = f.writes().find(c => c.args[1]?.endsWith('/pages'))!;
  expect(JSON.parse(write.input!)).toEqual({ build_type: 'workflow' });
});

it('stops after a failed Secret upload and redacts subprocess output', async () => {
  const f = fixture({ secretsFail: true });
  await expect(setupPages(true, f.d)).rejects.toThrow('已完成的配置会保留');
  expect(f.writes().some(c => c.args[0] === 'variable')).toBe(false);
  expect(f.logs.join('\n')).not.toContain('synthetic-password');
});

it('does not open the publication switch when the default branch changes during configuration', async () => {
  const f = fixture({ changedSha: true });
  await expect(setupPages(true, f.d)).rejects.toThrow('默认分支发生变化');
  expect(f.writes().some(c => c.args[0] === 'variable')).toBe(false);
});

it.each([
  [{ conclusion: 'failure' }, '工作流未成功'],
  [{ skipped: true }, '可能被跳过'],
  [{ wait: true }, '超过 15 分钟'],
  [{ runSha: otherSha }, '不同提交'],
  [{ dispatchId: false }, '返回结果不符合预期'],
] as const)('does not report successful deployment for %j', async (options, message) => {
  const f = fixture(options);
  await expect(setupPages(true, f.d)).rejects.toThrow(message);
  expect(f.logs.join('\n')).not.toContain('发布成功');
  expect(f.writes().filter(c => c.args.includes('DELETE'))).toEqual([]);
});

it('distinguishes HTTP errors, malformed responses and transport failure without printing bodies', () => {
  expect(parseApiResponse(response(null, 204))).toEqual({ status: 204, data: null });
  expect(parseApiResponse(response({}, 404)).status).toBe(404);
  expect(() => parseApiResponse({ code: 1, stdout: 'synthetic-password' })).toThrow('无法读取');
  expect(() => parseApiResponse({ ...response({}), code: 1 })).toThrow('未完成');
});

it('passes secret input through a pipe, scrubs private/debug env, and handles missing executables', async () => {
  vi.stubEnv('PKU_PASSWORD', 'synthetic-environment-secret');
  vi.stubEnv('CALENDAR_TOKEN', 'synthetic-token');
  vi.stubEnv('PAGES_CALENDAR_TOKEN', token);
  vi.stubEnv('GH_DEBUG', 'api');
  vi.stubEnv('GH_REPO', 'upstream/wrong-repo');
  vi.stubEnv('GH_HOST', 'elsewhere.example');
  const result = await command(process.execPath, ['--input-type=module', '-e',
    'let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({input, private:process.env.PKU_PASSWORD, token:process.env.CALENDAR_TOKEN, pagesToken:process.env.PAGES_CALENDAR_TOKEN, debug:process.env.GH_DEBUG, repo:process.env.GH_REPO, host:process.env.GH_HOST}));',
  ], 'synthetic-pipe-secret');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ input: 'synthetic-pipe-secret', host: 'github.com' });
  expect((await command('pku2cal-nonexistent-executable', [], 'synthetic-pipe-secret')).code).not.toBe(0);
});

it('persists one token and reuses it on subsequent initialization', async () => {
  const f = fixture();
  const random = vi.fn(f.d.randomToken);
  f.d.randomToken = random;
  const first = await setupPages(true, f.d);
  expect(await setupPages(true, f.d)).toBe(first);
  expect(random).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.saved.get('data/pages/calendar-owner/calendar.json')!)).toEqual({ repository: 'calendar-owner/calendar', token });
});

it('does not replace a missing local token when GitHub already has one', async () => {
  const f = fixture({ remoteToken: true });
  await expect(setupPages(true, f.d)).rejects.toThrow('本地 Pages 令牌文件缺失');
  expect(f.writes()).toEqual([]);
  expect(f.saved.size).toBe(0);
});

it('rejects a damaged local token without overwriting it', async () => {
  const f = fixture({ localToken: 'invalid' });
  await expect(setupPages(true, f.d)).rejects.toThrow('令牌文件无效');
  expect(f.writes()).toEqual([]);
});

it('stops before remote mutation if token persistence fails', async () => {
  const f = fixture();
  f.d.save = async () => { throw new Error('private path'); };
  await expect(setupPages(true, f.d)).rejects.toThrow('无法保存');
  expect(f.writes()).toEqual([]);
});

it('rotates explicitly and forces publication, then reuses the saved token on retry', async () => {
  const f = fixture({ localToken: Buffer.alloc(32, 2).toString('base64url') });
  await setupPages(true, f.d, { rotateToken: true });
  expect(JSON.parse(f.saved.get('data/pages/calendar-owner/calendar.json')!).token).toBe(token);
  const dispatch = f.calls.find(c => c.args[1]?.endsWith('/dispatches'))!;
  expect(JSON.parse(dispatch.input!).inputs).toMatchObject({ force_publish: true, snapshot_id: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await setupPages(true, f.d);
  const snapshots = f.calls.filter(c => c.args[0] === 'secret' && c.args[2] === 'PAGES_CALENDAR_SNAPSHOT');
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]!.input).toBe(snapshots[0]!.input);
});

it('accepts an explicitly unchanged run, but not for forced publication', async () => {
  const f = fixture({ unchanged: true });
  expect(await setupPages(true, f.d)).toContain(token);
  expect(f.logs.join('\n')).toContain('课表未变化');
  const forced = fixture({ unchanged: true });
  await expect(setupPages(true, forced.d, { forcePublish: true })).rejects.toThrow('可能被跳过');
});

it('rejects Actions execution before exposing a local subscription URL', async () => {
  const f = fixture();
  f.d.env.GITHUB_ACTIONS = 'true';
  await expect(setupPages(true, f.d)).rejects.toThrow('本机');
  expect(f.calls).toEqual([]);
});


it('rejects the unfilled SS table before uploading secrets or changing GitHub settings', async () => {
  const f = fixture({ selectedTimetable: 'pku-ss' });
  await expect(setupPages(true, f.d)).rejects.toMatchObject({ guidance: expect.stringContaining('config/timetables/pku-ss.json') });
  expect(f.calls.some(call => call.args.includes('--method') && call.args[call.args.indexOf('--method') + 1] !== 'GET')).toBe(false);
});
