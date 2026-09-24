import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { configWithPrivateConfirmations, validateConfig } from '../application/config.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { readPrivateConfirmations } from './node.js';

export class PagesSetupError extends Error {}

export interface CommandResult { code: number; stdout: string }
export type Command = (program: string, args: string[], input?: string) => Promise<CommandResult>;

/** Capture all child output: gh errors/debug output must never expose credentials. */
export const command: Command = (program, args, input) => new Promise(resolveResult => {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PKU_') || ['CALENDAR_TOKEN', 'GH_DEBUG', 'DEBUG', 'GH_REPO'].includes(key)) delete env[key];
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
  confirmations: () => Promise<string | undefined>;
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

export async function setupPages(publish: boolean, d: PagesDependencies): Promise<string> {
  if (!publish) throw new PagesSetupError('Pages 课表将公开可访问。确认后运行 npm run pages:setup -- --publish。');
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
  await checked('git', ['ls-files', '--error-unmatch', 'config/calendar.json', '.github/workflows/pages.yml'], '请先提交并推送 config/calendar.json 和 Pages 工作流。');

  let secrets: Record<string, string>;
  try {
    const config = validateConfig(JSON.parse(await d.read('config/calendar.json')));
    // Even an empty property is rejected to keep the public/private boundary explicit.
    if (config.unscheduledCourses !== undefined || !config.semesterBinding) throw new Error();
    assertGenerationAllowed(config, d.now());
    const effective = configWithPrivateConfirmations(config, await d.confirmations());
    const username = d.env.PKU_USERNAME;
    const password = d.env.PKU_PASSWORD;
    if (!username?.trim() || !password?.trim()) throw new Error();
    secrets = { PKU_USERNAME: username, PKU_PASSWORD: password,
      PKU_UNSCHEDULED_COURSES: JSON.stringify(effective.unscheduledCourses ?? []) };
  } catch {
    throw new PagesSetupError('本地配置无效：检查 .env 中的账号密码、私密确认列表，以及公共校历的学期绑定和有效期；公共校历不得包含 unscheduledCourses。');
  }
  await api('/actions/workflows/pages.yml');
  const pagesSchema = z.object({ build_type: z.enum(['legacy', 'workflow']), html_url: z.string().url() });
  const existing = await api('/pages', 'GET', undefined, true);
  const pages = existing === null ? null : pagesSchema.parse(existing);
  d.log('检查通过：远端默认分支与本地提交一致，本地校历和私密配置有效。');

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
    d.log('PUBLISH_CALENDAR=true 已设置；定时发布已开启。');
    stage = '触发首次发布';
    // Current GitHub API returns the dispatched run ID; never guess from the latest run.
    const dispatched = z.object({ workflow_run_id: z.number().int().positive() }).parse(
      await api('/actions/workflows/pages.yml/dispatches', 'POST', { ref: repo.default_branch }),
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
        const jobs = z.object({ jobs: z.array(z.object({ name: nonempty, conclusion: z.string().nullable() })) }).parse(await api(`${runPath}/jobs?per_page=100`)).jobs;
        if (!['generate', 'deploy'].every(name => jobs.some(job => job.name === name && job.conclusion === 'success'))) {
          throw new PagesSetupError('生成或部署任务未成功完成（可能被跳过），不能确认发布成功。');
        }
        break;
      }
      d.log('正在等待 GitHub 完成生成和部署…');
      await d.sleep(10_000);
    }
    stage = '获取订阅地址';
    const deployed = pagesSchema.parse(await api('/pages'));
    const site = new URL(deployed.html_url);
    if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password) throw new PagesSetupError('Pages 返回的站点地址无效。');
    site.pathname = site.pathname.replace(/\/?$/, '/') + 'calendar.ics';
    site.search = ''; site.hash = '';
    d.log(`发布成功。订阅地址：${site.href}`);
    return site.href;
  } catch (error) {
    const detail = error instanceof PagesSetupError ? error.message : '返回结果不符合预期，请检查 GitHub 设置或网络后重试。';
    throw new PagesSetupError(`${stage}失败：${detail}\n已完成的配置会保留，未删除既有站点或旧日历。修复后可重新运行；已开启的发布不会自动关闭。`);
  }
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { publish: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
      console.log('用法：npm run pages:setup -- --publish\n先安装 gh 并运行 gh auth login，手动提交并 push 到 origin 的默认分支。\n读取 .env 和 config/calendar.json；上传所需 Secrets，配置 Pages，公开发布并等待结果。');
      return;
    }
    await setupPages(values.publish === true, {
      command, read: path => readFile(path, 'utf8'), env: process.env,
      confirmations: () => readPrivateConfirmations(process.env.PKU_UNSCHEDULED_COURSES, process.env.PKU_UNSCHEDULED_COURSES_FILE),
      now: () => new Date(), sleep, log: message => console.log(message),
    });
  } catch (error) {
    console.error(error instanceof PagesSetupError ? error.message : 'Pages 初始化失败，请检查命令参数、GitHub 响应和本地配置。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
