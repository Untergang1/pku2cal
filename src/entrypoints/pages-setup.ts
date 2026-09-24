import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { readLocalSnapshot, withLock, reportLocalError } from './local-data.js';
import { encodeSnapshot } from '../application/snapshot.js';
import { newPagesToken, subscriptionUrl, validatePagesToken } from './pages-state.js';
import { savePrivateFile } from './private-files.js';

export class PagesSetupError extends Error {}

export interface CommandResult { code: number; stdout: string }
export type Command = (program: string, args: string[], input?: string) => Promise<CommandResult>;

/** Capture all child output: gh errors/debug output must never expose credentials. */
export const command: Command = (program, args, input) => new Promise(resolveResult => {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PKU_') || ['CALENDAR_TOKEN', 'PAGES_CALENDAR_TOKEN', 'PAGES_CALENDAR_SNAPSHOT', 'GH_DEBUG', 'DEBUG', 'GH_REPO'].includes(key)) delete env[key];
  }
  const child = execFile(program, args, { env, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    resolveResult({ code: error ? 1 : 0, stdout });
  });
  // A missing executable or an early exit can close the pipe before the write.
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
});

export function repositoryFromOrigin(origin: string): string {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(origin.trim());
  if (!match) throw new PagesSetupError('origin 必须是 github.com 的 SSH 或 HTTPS 仓库地址（不含凭据）。');
  const name = match[2]!.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new PagesSetupError('origin 仓库名无效。');
  return `${match[1]}/${name}`;
}

/** --include distinguishes a genuinely missing Pages site from auth/network errors. */
export function parseApiResponse(result: CommandResult): { status: number; data: unknown } {
  const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout);
  if (!match) throw new PagesSetupError('无法读取 GitHub API 响应，请检查 gh 版本、登录状态和网络。');
  const status = Number(match[1]);
  if (result.code !== 0 && status < 400) throw new PagesSetupError('GitHub 请求未完成，请检查网络后重试。');
  let data: unknown = null;
  try { if (match[2]!.trim()) data = JSON.parse(match[2]!); }
  catch { throw new PagesSetupError('GitHub API 返回了无法解析的响应。'); }
  return { status, data };
}

export interface PagesDependencies {
  command: Command;
  read: (path: string) => Promise<string>;
  save: (path: string, content: string) => Promise<void>;
  randomToken: () => string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  sleep: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
}

const nonempty = z.string().min(1);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runSchema = z.object({
  head_sha: shaSchema, status: nonempty, conclusion: z.string().nullable(),
});

export async function setupPages(publish: boolean, d: PagesDependencies, options: { rotateToken?: boolean; forcePublish?: boolean; config?: string | undefined; schedule?: string | undefined } = {}): Promise<string> {
  if (!publish) throw new PagesSetupError('Pages 课表将公开可访问。确认后运行 npm run pages:publish。');
  if (d.env.GITHUB_ACTIONS === 'true') throw new PagesSetupError('请在本机运行初始化，避免把完整订阅地址写入 Actions 日志。');
  const snapshot = await readLocalSnapshot(options, d.read, d.now());
  const checked = async (program: string, args: string[], message: string, input?: string): Promise<string> => {
    const result = await d.command(program, args, input);
    if (result.code !== 0) throw new PagesSetupError(message);
    return result.stdout.trim();
  };
  await checked('gh', ['--version'], '请先安装 GitHub CLI（gh）。');
  await checked('gh', ['auth', 'status', '--hostname', 'github.com'], '请先运行 gh auth login，登录有权管理目标仓库的账号。');
  const root = await checked('git', ['rev-parse', '--show-prefix'], '请在项目仓库根目录运行。');
  if (root) throw new PagesSetupError('请在项目仓库根目录运行。');
  const dirty = await checked('git', ['status', '--porcelain', '--untracked-files=normal'], '无法检查 Git 工作区。');
  if (dirty) throw new PagesSetupError('请先提交项目更改并手动 push；工作区必须干净（忽略的私密文件不受影响）。');
  const origin = await checked('git', ['remote', 'get-url', 'origin'], '请先配置指向自己 GitHub 仓库的 origin。');
  const repository = repositoryFromOrigin(origin);
  const pushOrigin = await checked('git', ['remote', 'get-url', '--push', 'origin'], '无法检查 origin 的推送地址。');
  if (repositoryFromOrigin(pushOrigin).toLowerCase() !== repository.toLowerCase()) {
    throw new PagesSetupError('origin 的读取和推送地址指向不同仓库，请先统一目标仓库。');
  }
  d.log(`目标仓库：${repository}；本次操作会公开发布课表。`);
  const base = `repos/${repository}`;
  const api = async (path: string, method = 'GET', body?: unknown, allowMissing = false): Promise<unknown> => {
    const args = ['api', `${base}${path}`, '--hostname', 'github.com', '--include', '--method', method,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (body !== undefined) args.push('--input', '-');
    const response = parseApiResponse(await d.command('gh', args, body === undefined ? undefined : JSON.stringify(body)));
    if (allowMissing && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new PagesSetupError(`GitHub ${method} ${path || '/repository'} 失败（HTTP ${response.status}）。请检查仓库权限、Actions/Pages 设置及网络。`);
    }
    return response.data;
  };
  const repo = z.object({ default_branch: nonempty, archived: z.boolean(), permissions: z.object({ push: z.boolean() }) }).parse(await api(''));
  if (repo.archived || !repo.permissions.push) throw new PagesSetupError('目标仓库已归档或当前账号没有写入权限。');
  const localSha = shaSchema.parse(await checked('git', ['rev-parse', 'HEAD'], '无法读取当前提交。'));
  const headPath = `/commits/${encodeURIComponent(repo.default_branch)}`;
  const remoteSha = z.object({ sha: shaSchema }).parse(await api(headPath)).sha;
  if (localSha !== remoteSha) throw new PagesSetupError('本地 HEAD 与远端默认分支不同。请先同步并手动 push 到默认分支，再运行此命令。');
  await checked('git', ['ls-files', '--error-unmatch', '.github/workflows/pages.yml'], '请先提交并推送新的 Pages 工作流。');
  await api('/actions/workflows/pages.yml');
  const pagesSchema = z.object({ build_type: z.enum(['legacy', 'workflow']), html_url: z.string().url() });
  const existing = await api('/pages', 'GET', undefined, true);
  const pages = existing === null ? null : pagesSchema.parse(existing);
  d.log('检查通过：远端默认分支与本地提交一致，本地课表快照有效。');

  const statePath = `data/pages/${repository.toLowerCase()}.json`;
  let token: string | undefined;
  try {
    const state = z.object({ repository: z.literal(repository.toLowerCase()), token: z.string() }).parse(JSON.parse(await d.read(statePath)));
    token = validatePagesToken(state.token);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new PagesSetupError('本地 Pages 令牌文件无效，请恢复正确的私密文件；不会自动覆盖。');
    }
  }
  if (!token && !options.rotateToken) {
    const remote = await api('/actions/secrets/PAGES_CALENDAR_SNAPSHOT', 'GET', undefined, true);
    if (remote !== null) throw new PagesSetupError('本地 Pages 令牌文件缺失，但远端已有 Secret。请恢复 data/pages 下的私密文件，或使用 --rotate-token 更换订阅地址。');
  }
  if (!token || options.rotateToken) {
    token = validatePagesToken(d.randomToken());
    try { await d.save(statePath, JSON.stringify({ repository: repository.toLowerCase(), token }) + '\n'); }
    catch { throw new PagesSetupError('无法保存本地 Pages 令牌，尚未修改远端配置。'); }
  }
  const payload = encodeSnapshot(snapshot, token);
  const secrets = { PAGES_CALENDAR_SNAPSHOT: payload.encoded };
  let unchanged = false;
  let stage = '配置 Pages';
  try {
    if (!pages) await api('/pages', 'POST', { build_type: 'workflow' });
    else if (pages.build_type !== 'workflow') await api('/pages', 'PUT', { build_type: 'workflow' });
    d.log('Pages 发布来源已就绪：GitHub Actions。');
    stage = '上传 Secrets';
    for (const [name, value] of Object.entries(secrets)) {
      await checked('gh', ['secret', 'set', name, '--repo', repository, '--app', 'actions'], `设置 ${name} 失败，请检查 Secrets 写入权限。`, value);
      d.log(`${name} 已更新。`);
    }
    stage = '启用工作流';
    await api('/actions/workflows/pages.yml/enable', 'PUT');
    // Recheck after setup in case another user pushed while Secrets were uploaded.
    if (z.object({ sha: shaSchema }).parse(await api(headPath)).sha !== localSha) {
      throw new PagesSetupError('配置期间远端默认分支发生变化，请同步后重试。');
    }
    stage = '开启发布';
    await checked('gh', ['variable', 'set', 'PUBLISH_CALENDAR', '--body', 'true', '--repo', repository], '无法设置 PUBLISH_CALENDAR，请检查 Variables 写入权限。');
    d.log('PUBLISH_CALENDAR=true 已设置；仅支持手动快照发布。');
    stage = '触发首次发布';
    // Current GitHub API returns the dispatched run ID; never guess from the latest run.
    const dispatched = z.object({ workflow_run_id: z.number().int().positive() }).parse(
      await api('/actions/workflows/pages.yml/dispatches', 'POST', { ref: repo.default_branch, inputs: { snapshot_id: payload.digest, force_publish: options.forcePublish === true || options.rotateToken === true } }),
    );
    const runPath = `/actions/runs/${dispatched.workflow_run_id}`;
    const runUrl = `https://github.com/${repository}/actions/runs/${dispatched.workflow_run_id}`;
    d.log(`本次运行：${runUrl}`);
    stage = `等待发布（${runUrl}）`;
    const deadline = d.now().getTime() + 15 * 60_000;
    for (;;) {
      if (d.now().getTime() >= deadline) throw new PagesSetupError('等待超过 15 分钟；远端任务未取消，请在运行页面检查排队或审批状态。');
      const run = runSchema.parse(await api(runPath));
      if (run.head_sha !== localSha) throw new PagesSetupError('远端运行使用了不同提交，请在运行页面检查后重新同步。');
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new PagesSetupError('本次工作流未成功，请在运行页面检查失败步骤。');
        const jobs = z.object({ jobs: z.array(z.object({ name: nonempty, conclusion: z.string().nullable(),
          steps: z.array(z.object({ name: nonempty, conclusion: z.string().nullable() })).default([]),
        })) }).parse(await api(`${runPath}/jobs?per_page=100`)).jobs;
        const generate = jobs.find(job => job.name === 'generate');
        const deploy = jobs.find(job => job.name === 'deploy');
        unchanged = generate?.conclusion === 'success' && deploy?.conclusion === 'skipped'
          && generate.steps.some(step => step.name === 'Calendar unchanged' && step.conclusion === 'success');
        if (generate?.conclusion !== 'success' || !(deploy?.conclusion === 'success' || unchanged)
          || (unchanged && (options.forcePublish || options.rotateToken))) {
          throw new PagesSetupError('生成或部署任务未成功完成（可能被跳过），不能确认发布成功。');
        }
        break;
      }
      d.log('正在等待 GitHub 完成快照检查和部署…');
      await d.sleep(10_000);
    }
    stage = '获取订阅地址';
    const deployed = pagesSchema.parse(await api('/pages'));
    const url = subscriptionUrl(deployed.html_url, token);
    d.log(`${unchanged ? '课表未变化，保留现有发布' : '发布成功'}。订阅地址（请保密）：${url}`);
    return url;
  } catch (error) {
    const detail = error instanceof PagesSetupError ? error.message : '返回结果不符合预期，请检查 GitHub 设置或网络后重试。';
    throw new PagesSetupError(`${stage}失败：${detail}\n已完成的配置会保留，未删除既有站点或旧日历。修复后可重新运行；旧部署保留，超时不会取消远端任务。`);
  }
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { 'rotate-token': { type: 'boolean' }, 'force-publish': { type: 'boolean' },
      config: { type: 'string', default: 'config/calendar.json' }, schedule: { type: 'string', default: 'data/schedule.yaml' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
      console.log('npm run pages:publish [-- --config config/calendar.json --schedule data/schedule.yaml --force-publish --rotate-token]\n显式公开发布本地课表快照；仅手动触发，不登录北大。先提交并推送代码，登录 gh；私密 YAML 不提交。');
      return;
    }
    await withLock(resolve('data/pages/publish.lock'), () => setupPages(true, {
      command, read: path => readFile(path, 'utf8'), save: savePrivateFile, randomToken: newPagesToken, env: process.env,
      now: () => new Date(), sleep, log: message => console.log(message),
    }, { rotateToken: values['rotate-token'] === true, forcePublish: values['force-publish'] === true, config: values.config, schedule: values.schedule }));
  } catch (error) {
    if (error instanceof PagesSetupError) console.error(error.message); else reportLocalError(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
