import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { configWithPrivateConfirmations, TimetableConfigError } from '../application/config.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { resolveCalendarConfig } from './calendar-config.js';
import { cloudflareId, newWorkerToken, saveWorkerFile, workerName, workerState } from './worker-state.js';
import { cloudflareReader, verifyWorker, workerCommand, WorkerSetupError, type WorkerCommand } from './worker-cloudflare.js';

const placeholder = '0'.repeat(32);
const baseSchema = z.object({
  $schema: z.string().optional(), name: workerName, main: z.literal('dist/worker.mjs'),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), compatibility_flags: z.array(z.string()),
  no_bundle: z.literal(true), build: z.object({ command: z.string().min(1) }).strict(),
  kv_namespaces: z.tuple([z.object({ binding: z.literal('CALENDAR_KV'), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict()]),
  observability: z.object({ enabled: z.literal(false) }).strict(), upload_source_maps: z.literal(false),
  account_id: cloudflareId.optional(), workers_dev: z.literal(true).optional(), preview_urls: z.literal(false).optional(),
}).strict();
type Base = z.infer<typeof baseSchema>;

/** Keep runtime settings in the tracked Wrangler file; resolve paths for the generated config. */
export function deploymentConfig(base: Base, name: string, account?: string, namespace = placeholder) {
  const { $schema: _schema, account_id: _account, ...settings } = base;
  return { ...settings, name, ...(account ? { account_id: account } : {}),
    main: resolve(base.main), build: { ...base.build, cwd: resolve('.') },
    kv_namespaces: [{ binding: 'CALENDAR_KV', id: namespace }], workers_dev: true, preview_urls: false,
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
export interface WorkerSetupOptions { deploy: boolean; rotateToken?: boolean; account?: string; name?: string }

export async function setupWorker(options: WorkerSetupOptions, d: WorkerSetupDependencies): Promise<string> {
  if (!options.deploy) throw new WorkerSetupError('运行 npm run worker:setup -- --deploy 才会创建资源、上传 Secrets 并部署。');
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
    const configPath = resolve(d.env.PKU_CONFIG_PATH || 'config/calendar.json');
    const { config } = await resolveCalendarConfig(JSON.parse(await d.read(configPath)), file => d.read(fileURLToPath(file)));
    if (config.unscheduledCourses !== undefined || !config.semesterBinding) throw new Error();
    assertGenerationAllowed(config, d.now());
    const confirmationFile = d.env.PKU_UNSCHEDULED_COURSES_FILE;
    if (confirmationFile?.trim() && d.env.PKU_UNSCHEDULED_COURSES?.trim()) throw new Error();
    const confirmations = confirmationFile?.trim() ? await d.read(resolve(confirmationFile)) : d.env.PKU_UNSCHEDULED_COURSES;
    const effective = configWithPrivateConfirmations(config, confirmations);
    if (!d.env.PKU_USERNAME?.trim() || !d.env.PKU_PASSWORD?.trim()) throw new Error();
    const secrets: Record<string, string> = { PKU_USERNAME: d.env.PKU_USERNAME, PKU_PASSWORD: d.env.PKU_PASSWORD,
      PKU_UNSCHEDULED_COURSES: JSON.stringify(effective.unscheduledCourses ?? []) };
    const temporaryConfig = resolve(d.directory, 'wrangler.json');
    const secretPath = resolve(d.directory, 'secrets.json');
    const buildEnv = { PKU_CONFIG_PATH: configPath };
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
    try {
      state = workerState.parse(JSON.parse(await d.read(statePath)));
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
    let remoteNamespace: string | undefined;
    if (remote !== null) {
      const bindings = z.object({ bindings: z.array(z.object({ name: z.string(), type: z.string(), namespace_id: z.string().optional() })) }).parse(remote).bindings;
      remoteNamespace = bindings.find(item => item.name === 'CALENDAR_KV' && item.type === 'kv_namespace')?.namespace_id;
      if (!remoteNamespace || !['PKU_USERNAME', 'PKU_PASSWORD', 'CALENDAR_TOKEN'].every(key => bindings.some(item => item.name === key && item.type === 'secret_text'))) {
        throw new WorkerSetupError('同名 Worker 不是可识别的 pku2cal 部署；请用 --name <新名称>，不会覆盖该 Worker。');
      }
      cloudflareId.parse(remoteNamespace);
      if (!state && !options.rotateToken) throw new WorkerSetupError('云端已有 Worker 令牌，但本地状态文件缺失；请恢复 data/worker 文件，或显式 --rotate-token 更换订阅地址。');
    }
    const configuredNamespace = base.kv_namespaces[0].id === placeholder ? undefined : base.kv_namespaces[0].id;
    if (configuredNamespace && (name !== base.name || base.account_id && base.account_id !== account)) {
      throw new WorkerSetupError('现有 Wrangler KV 绑定属于其他部署目标；请先核对账号、名称和 namespace。');
    }
    const candidates = [state?.namespaceId, remoteNamespace, configuredNamespace].filter((value): value is string => !!value);
    if (new Set(candidates).size > 1) throw new WorkerSetupError('本地状态、Wrangler 配置与云端 KV 绑定冲突；请核对后重试，不会替换缓存。');
    let namespace = candidates[0];
    const cliEnv = { ...buildEnv, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: credentials.token };
    await d.save(temporaryConfig, JSON.stringify(deploymentConfig(base, name, account)));
    const listNamespaces = async () => z.array(z.object({ id: cloudflareId, title: z.string() }))
      .parse(JSON.parse(await d.command(['kv', 'namespace', 'list', '--config', temporaryConfig], cliEnv)));
    const namespaces = await listNamespaces();
    const title = `${name}-CALENDAR_KV`;
    if (namespace && !namespaces.some(item => item.id === namespace)) throw new WorkerSetupError('已保存的 KV namespace 不存在或不可访问；不会创建新缓存替代，请核对账号和资源。');
    if (!namespace) {
      const matches = namespaces.filter(item => item.title === title);
      if (matches.length > 1 || matches.length && !state) throw new WorkerSetupError('存在同名 KV，但无法确认属于本次初始化；请恢复本地状态或使用其他 Worker 名称。');
      namespace = matches[0]?.id;
    }
    state = workerState.parse({ accountId: account, name,
      token: !state || options.rotateToken ? d.randomToken() : state.token, ...(namespace ? { namespaceId: namespace } : {}) });
    await d.save(statePath, JSON.stringify(state) + '\n');

    progress('准备 KV');
    if (!namespace) {
      await d.command(['kv', 'namespace', 'create', title, '--update-config=false', '--config', temporaryConfig], cliEnv);
      const matches = (await listNamespaces()).filter(item => item.title === title);
      if (matches.length !== 1) throw new WorkerSetupError('KV 创建结果无法确认；资源和本地令牌已保留，请重跑以恢复。');
      namespace = matches[0]!.id;
    }
    state.namespaceId = namespace;
    await d.save(statePath, JSON.stringify(state) + '\n');
    const finalConfig = deploymentConfig(base, name, account, namespace);
    await d.save(temporaryConfig, JSON.stringify(finalConfig));
    await d.save(`data/worker/${account}/${name}.wrangler.json`, JSON.stringify(finalConfig, null, 2) + '\n');
    secrets.CALENDAR_TOKEN = state.token;
    assertGenerationAllowed(config, d.now());
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
    await verifyWorker(url, d.fetch, d.sleep);
    d.log('部署与云端日历验证通过；完整订阅地址仅在本机显示，请保密。');
    return url;
  } catch (error) {
    const detail = error instanceof WorkerSetupError ? error.message
      : error instanceof TimetableConfigError ? error.guidance
      : '请检查本地配置、学期有效期、私密确认列表及 Cloudflare 响应；详细私密内容不输出。';
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
      deploy: { type: 'boolean' }, 'rotate-token': { type: 'boolean' }, account: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('用法：npm run worker:setup -- --deploy [--account <账号 ID>] [--name <Worker 名称>] [--rotate-token]\n先运行 npx wrangler login，并在 Cloudflare Workers & Pages 中设置 workers.dev 子域名。\n读取 .env、校历和私密确认列表；创建或复用 KV，保存令牌，部署代码和 Secrets，验证后输出订阅地址。\n重复运行更新部署；轮换失败后不带 --rotate-token 重试。请备份 data/worker 中的状态 JSON。');
      return;
    }
    if (!values.deploy) throw new WorkerSetupError('请使用 npm run worker:setup -- --deploy；该命令会创建云端资源并部署。');
    const url = await withWorkerSetupDirectory(directory => setupWorker({ deploy: true,
      ...(values.account !== undefined ? { account: values.account } : {}), ...(values.name !== undefined ? { name: values.name } : {}), rotateToken: !!values['rotate-token'],
    }, {
      directory, env: process.env, read: path => readFile(path, 'utf8'), save: saveWorkerFile,
      remove: path => rm(path, { force: true }), command: workerCommand(directory), fetch, now: () => new Date(),
      randomToken: newWorkerToken, sleep, log: message => console.log(message),
    }));
    console.log(url);
  } catch (error) {
    console.error(error instanceof WorkerSetupError ? error.message : 'Worker 初始化失败；检查命令参数与本地文件权限后重试。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
