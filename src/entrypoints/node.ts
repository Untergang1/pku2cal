import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateCalendar, type GenerationDependencies, type GeneratedCalendar } from '../application/generate.js';
import { errorCategory, logRecord } from '../application/log.js';
import type { Credentials } from '../pku/auth.js';
import { ConfigError, configWithPrivateConfirmations, validateConfig } from '../application/config.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { semesterStatus } from '../application/setup.js';

export async function readPrivateConfirmations(inline: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (!file?.trim()) return inline;
  if (inline?.trim()) throw new ConfigError();
  return readFile(resolve(file), 'utf8');
}

/** File replacement is the final operation, after complete successful generation. */
export async function generateFile(options: {
  config: unknown; output: string; credentials: Credentials; dependencies: GenerationDependencies;
}): Promise<GeneratedCalendar> {
  const result = await generateCalendar(options.config, options.credentials, options.dependencies);
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, result.ics, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    assertGenerationAllowed(validateConfig(options.config), options.dependencies.now());
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return result;
}

export async function main(): Promise<void> {
  const started = Date.now();
  try {
    const { values } = parseArgs({ options: {
      config: { type: 'string', default: 'config/calendar.json' }, output: { type: 'string', default: 'data/calendar.ics' },
      confirmations: { type: 'string' }, status: { type: 'boolean' }, help: { type: 'boolean' },
    }, strict: true });
    if (values.help) {
      console.log('用法：npm run generate [-- --config config/calendar.json --output data/calendar.ics --confirmations data/confirmed-courses.json]\n先运行 npm run setup 选择校历；npm run status 可查看学期和日期状态，不会登录或生成。');
      return;
    }
    let input: unknown;
    try { input = JSON.parse(await readFile(resolve(values.config), 'utf8')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        console.error('尚未找到校历配置。请先运行 npm run setup，或用 --config 指定已有配置。');
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    if (values.status) {
      for (const line of semesterStatus(validateConfig(input), new Date())) console.log(line);
      console.log('这里只检查学期和日期；课程与凭据将在生成时验证。');
      return;
    }
    const confirmations = await readPrivateConfirmations(process.env.PKU_UNSCHEDULED_COURSES, values.confirmations ?? process.env.PKU_UNSCHEDULED_COURSES_FILE);
    const config = configWithPrivateConfirmations(input, confirmations);
    await generateFile({ config, output: values.output, credentials: {
      username: process.env.PKU_USERNAME ?? '', password: process.env.PKU_PASSWORD ?? '',
    }, dependencies: { fetch, now: () => new Date() } });
    logRecord({ stage: 'generate', category: 'success', durationMs: Date.now() - started });
  } catch (error) {
    logRecord({ stage: 'generate', category: errorCategory(error), durationMs: Date.now() - started });
    const guidance: Record<string, string> = {
      'semester:expired': '该学期已超过生成有效期，旧文件已保留。请更新并选择新学期校历。',
      'semester:not_started': '尚未到达校历中的开始日期，暂不生成；可用 npm run status 查看。',
      'parse:semester': '上游学期缺失或与配置不符。请核实当前选课学期，并运行 npm run setup 选择对应校历。',
      'schedule:time': '存在无法识别时间的课程，未生成日历。请核实时间说明；确无固定时间的课程需单独确认。',
    };
    const message = guidance[errorCategory(error)];
    if (message) console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
