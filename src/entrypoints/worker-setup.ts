import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { DocumentError } from '../schedule/document.js';
import { TimetableConfigError } from '../application/config.js';
import { readLocalSnapshot, reportLocalError } from './local-data.js';
import { SnapshotError, validateSnapshot } from '../application/snapshot.js';
import { cloudflareId, newWorkerToken, saveWorkerFile, workerName, workerState, legacyWorkerState } from './worker-state.js';
import { cloudflareReader, verifyWorker, workerCommand, WorkerSetupError, type WorkerCommand } from './worker-cloudflare.js';

const baseSchema = z.object({
  $schema: z.string().optional(), name: workerName, main: z.literal('dist/worker.mjs'),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), compatibility_flags: z.array(z.string()),
  no_bundle: z.literal(true), build: z.object({ command: z.string().min(1) }).strict(),
  vars: z.object({ PKU2CAL_MODE: z.literal('snapshot-v1') }).strict(),
  observability: z.object({ enabled: z.literal(false) }).strict(), upload_source_maps: z.literal(false),
  account_id: cloudflareId.optional(), workers_dev: z.literal(true).optional(), preview_urls: z.literal(false).optional(),
}).strict();
type Base = z.infer<typeof baseSchema>;

/** Keep runtime settings in the tracked Wrangler file; resolve paths for the generated config. */
export function deploymentConfig(base: Base, name: string, account?: string) {
  const { $schema: _schema, account_id: _account, ...settings } = base;
  return { ...settings, name, ...(account ? { account_id: account } : {}),
    main: resolve(base.main), build: { ...base.build, cwd: resolve('.') },
    workers_dev: true, preview_urls: false,
  };
}

export interface WorkerSetupDependencies {
  env: NodeJS.ProcessEnv;
  directory: string;
  read: (path: string) => Promise<string>;
  save: (path: string, content: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  command: WorkerCommand;
  fetch: typeof fetch;
  now: () => Date;
  randomToken: () => string;
  sleep: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
}
export interface WorkerSetupOptions { deploy: boolean; rotateToken?: boolean; account?: string; name?: string; config?: string | undefined; schedule?: string | undefined }

export async function setupWorker(options: WorkerSetupOptions, d: WorkerSetupDependencies): Promise<string> {
  if (!options.deploy) throw new WorkerSetupError('运行 npm run worker:deploy 才会创建资源、上传 Secrets 并部署。');
  if (d.env.CI || d.env.GITHUB_ACTIONS === 'true') throw new WorkerSetupError('请在本机运行初始化，避免把私密订阅地址写入 CI 日志。');
  let stage = '本地配置';
  let deployed = false;
  const progress = (value: string) => { stage = value; d.log(`Worker：${value}。`); };
  try {
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(await d.read('wrangler.jsonc'), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error();
    const base = baseSchema.parse(parsed);
    const name = workerName.parse(options.name ?? base.name);
    const snapshot = validateSnapshot(await readLocalSnapshot(options, d.read, d.now()));
    const secrets: Record<string, string> = {};
    const snapshotPath = resolve(d.directory, 'snapshot.json');
    await d.save(snapshotPath, JSON.stringify(snapshot));
    const temporaryConfig = resolve(d.directory, 'wrangler.json');
    const secretPath = resolve(d.directory, 'secrets.json');
    const buildEnv = { PKU_SNAPSHOT_PATH: snapshotPath };
    await d.save(temporaryConfig, JSON.stringify(deploymentConfig(base, name)));
    progress('本地构建检查');
    await d.command(['deploy', '--dry-run', '--config', temporaryConfig, '--outdir', resolve(d.directory, 'build')], buildEnv);

    progress('Cloudflare 登录与目标检查');
    const identity = z.object({ loggedIn: z.literal(true), accounts: z.array(z.object({ id: cloudflareId })) })
      .parse(JSON.parse(await d.command(['whoami', '--json', '--config', temporaryConfig])));
    const selected = options.account ?? d.env.CLOUDFLARE_ACCOUNT_ID ?? base.account_id;
    if (!selected && identity.accounts.length !== 1) {
      throw new WorkerSetupError('无法唯一确定账号；请运行 npx wrangler whoami 查看账号，然后用 --account <账号 ID> 指定。');
    }
    const account = cloudflareId.parse(selected ?? identity.accounts[0]?.id);
    if (!identity.accounts.some(item => item.id === account)) throw new WorkerSetupError('指定账号不在当前 Wrangler 登录可访问的账号中。');
    d.log(`目标账号：${account}；Worker：${name}。`);
    const credentials = z.object({ type: z.enum(['oauth', 'api_token']), token: z.string().min(1) })
      .parse(JSON.parse(await d.command(['auth', 'token', '--json', '--config', temporaryConfig])));
    const api = cloudflareReader(credentials.token, account, d.fetch);
    const statePath = `data/worker/${account}/${name}.json`;
    let state: z.infer<typeof workerState> | undefined;
    let legacyNamespace: string | undefined;
    let legacyStateText: string | undefined;
    try {
      const text = await d.read(statePath);
      const input: unknown = JSON.parse(text);
      const current = workerState.safeParse(input);
      if (current.success) state = current.data;
      else {
        const legacy = legacyWorkerState.parse(input);
        legacyNamespace = legacy.namespaceId;
        legacyStateText = text;
        const { namespaceId: _namespace, ...clean } = legacy;
        state = clean;
      }
      if (state.accountId !== account || state.name !== name) throw new Error();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new WorkerSetupError('本地 Worker 状态文件损坏或目标不符；请恢复 data/worker 中的正确文件，不会自动覆盖。');
      }
    }
    let subdomain: string;
    try { subdomain = z.object({ subdomain: workerName }).parse(await api('/workers/subdomain')).subdomain; }
    catch { throw new WorkerSetupError('无法读取 workers.dev 子域名；请检查账号权限，并在 Cloudflare Workers & Pages 中完成子域名设置。'); }
    const remote = await api(`/workers/scripts/${name}/settings`, true);
    let remoteSecretNames: string[] = [];
    if (remote !== null) {
      const bindings = z.object({ bindings: z.array(z.object({ name: z.string(), type: z.string(), namespace_id: z.string().optional(), text: z.string().optional() })) }).parse(remote).bindings;
      remoteSecretNames = bindings.filter(item => item.type === 'secret_text').map(item => item.name);
      const remoteNamespace = bindings.find(item => item.name === 'CALENDAR_KV' && item.type === 'kv_namespace')?.namespace_id;
      const current = bindings.some(item => item.name === 'PKU2CAL_MODE' && item.type === 'plain_text' && item.text === 'snapshot-v1');
      const legacy = !!remoteNamespace && ['PKU_USERNAME', 'PKU_PASSWORD'].every(key => remoteSecretNames.includes(key));
      if (!remoteSecretNames.includes('CALENDAR_TOKEN') || !(current || legacy)) throw new WorkerSetupError('同名 Worker 不是可识别的 pku2cal 部署；不会覆盖。');
      if (legacyNamespace && remoteNamespace && remoteNamespace !== legacyNamespace) throw new WorkerSetupError('本地旧 KV 与云端绑定冲突，请核对后重试。');
      if (!state && !options.rotateToken) throw new WorkerSetupError('云端已有 Worker 令牌，但本地状态文件缺失；请恢复状态，或显式 --rotate-token。');
    }
    const cliEnv = { ...buildEnv, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: credentials.token };
    state = workerState.parse({ accountId: account, name, token: !state || options.rotateToken ? d.randomToken() : state.token });
    if (legacyStateText) {
      try { await d.read(`${statePath}.pre-snapshot.bak`); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        await d.save(`${statePath}.pre-snapshot.bak`, legacyStateText);
      }
    }
    // Keep the old namespace in state until the replacement deployment is verified.
    await d.save(statePath, JSON.stringify(legacyNamespace ? { ...state, namespaceId: legacyNamespace } : state) + '\n');
    const finalConfig = deploymentConfig(base, name, account);
    await d.save(temporaryConfig, JSON.stringify(finalConfig));
    await d.save(`data/worker/${account}/${name}.wrangler.json`, JSON.stringify(finalConfig, null, 2) + '\n');
    secrets.CALENDAR_TOKEN = state.token;
    progress('部署代码和 Secrets');
    try {
      await d.save(secretPath, JSON.stringify(secrets));
      await d.command(['deploy', '--config', temporaryConfig, '--secrets-file', secretPath], cliEnv);
      deployed = true;
    } finally {
      await d.remove(secretPath);
    }
    progress('验证云端日历');
    z.object({ enabled: z.literal(true) }).parse(await api(`/workers/scripts/${name}/subdomain`));
    const url = `https://${name}.${subdomain}.workers.dev/calendar/${state.token}.ics`;
    await verifyWorker(url, d.fetch, d.sleep, snapshot.ics);
    await d.save(statePath, JSON.stringify(state) + '\n');
    progress('清理旧 Secrets');
    for (const key of ['PKU_USERNAME', 'PKU_PASSWORD', 'PKU_UNSCHEDULED_COURSES', 'PKU_COURSE_SUPPLEMENTS']) {
      if (remoteSecretNames.includes(key)) {
        try { await d.command(['secret', 'delete', key, '--config', temporaryConfig], cliEnv); }
        catch { throw new WorkerSetupError('发布成功、旧 Secrets 清理未完成；请重跑 worker:deploy 完成清理。'); }
      }
    }
    d.log('部署与云端日历验证通过；完整订阅地址仅在本机显示，请保密。');
    return url;
  } catch (error) {
    const detail = error instanceof WorkerSetupError || error instanceof DocumentError ? error.message
      : error instanceof TimetableConfigError ? error.guidance
      : error instanceof SnapshotError ? error.guidance
      : '请检查本地配置、本地课表快照及 Cloudflare 响应；详细私密内容不输出。';
    throw new WorkerSetupError(`Worker 初始化失败（${stage}）：${detail}${deployed ? ' 已完成部署，不会自动回滚。' : ''}`);
  }
}

/** Serialize local initialization so two runs cannot replace each other's token. */
export async function withWorkerSetupDirectory<T>(run: (directory: string) => Promise<T>, root = resolve('data/worker')): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = resolve(root, 'setup.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new WorkerSetupError('另一个初始化可能正在运行；若上次被强制终止，请确认没有运行中的任务后删除 data/worker/setup.lock 再重试。'); }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(resolve(root, '.run-'));
    return await run(directory);
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ strict: true, options: {
      'rotate-token': { type: 'boolean' }, account: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' },
      config: { type: 'string', default: 'config/calendar.json' }, schedule: { type: 'string', default: 'data/schedule.yaml' },
    } });
    if (values.help) {
      console.log('npm run worker:deploy [-- --config config/calendar.json --schedule data/schedule.yaml --account <账号 ID> --name pku2cal --rotate-token]\n从本地 YAML 生成快照并部署，复用订阅令牌；不登录北大、不创建 KV。');
      return;
    }
    await withWorkerSetupDirectory(async directory => {
      const url = await setupWorker({ deploy: true, rotateToken: values['rotate-token'] === true,
        ...(values.account ? { account: values.account } : {}), ...(values.name ? { name: values.name } : {}), config: values.config, schedule: values.schedule }, {
        env: process.env, directory, read: path => readFile(resolve(path), 'utf8'), save: saveWorkerFile,
        remove: path => rm(path, { force: true }), command: workerCommand(directory), fetch, now: () => new Date(),
        randomToken: newWorkerToken, sleep, log: console.log,
      });
      console.log(`订阅地址（请保密）：${url}`);
    });
  } catch (error) {
    if (error instanceof WorkerSetupError) console.error(error.message); else reportLocalError(error);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
