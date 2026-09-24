import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { validateConfig, type CalendarConfig } from '../application/config.js';
import { selectSemester, semesterStatus, SetupError, type SemesterPreset } from '../application/setup.js';

const catalogueSchema = z.array(z.strictObject({
  semester: z.string(), label: z.string().min(1),
  calendarFile: z.string().regex(/^[a-z0-9-]+\.json$/),
  validThrough: z.string(), source: z.url(),
}));

export async function loadPresets(directory = new URL('../../config/', import.meta.url)): Promise<SemesterPreset[]> {
  const catalogue = catalogueSchema.safeParse(JSON.parse(await readFile(new URL('semesters.json', directory), 'utf8')));
  if (!catalogue.success) throw new SetupError('catalogue');
  return Promise.all(catalogue.data.map(async entry => {
    const calendar = validateConfig(JSON.parse(await readFile(new URL(entry.calendarFile, directory), 'utf8')));
    if (calendar.semester !== entry.semester || calendar.unscheduledCourses?.length) throw new SetupError('catalogue');
    return { label: entry.label, source: entry.source, calendar, validThrough: entry.validThrough };
  }));
}

/** Never replace an existing user's namespace, calendar, or private decisions. */
export async function initializeCalendar(output: string, config: CalendarConfig): Promise<'created' | 'unchanged'> {
  const valid = validateConfig(config);
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(valid, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    try {
      if (JSON.stringify(validateConfig(JSON.parse(await readFile(path, 'utf8')))) === JSON.stringify(valid)) return 'unchanged';
    } catch { /* Existing files must be preserved even if malformed. */ }
    throw new SetupError('exists');
  }
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: { semester: { type: 'string' }, output: { type: 'string', default: 'config/calendar.json' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) {
      console.log('用法：npm run setup [-- --semester 2026-2027-1] [--output config/calendar.json]\n默认按北京时间选择已核实的校本部校历，自动填入生成起止日期。');
      return;
    }
    const now = new Date();
    const selected = selectSemester(await loadPresets(), now, values.semester);
    const result = await initializeCalendar(values.output, selected.config);
    console.log(`${selected.label}\n${result === 'created' ? '学期配置已创建。' : '学期配置已就绪。'}`);
    for (const line of semesterStatus(selected.config, now)) console.log(line);
    console.log('配置文件：' + values.output);
    console.log('校历来源：' + selected.source);
    console.log('下一步：在 .env 中填写凭据，然后运行 npm run generate。');
  } catch (error) {
    const messages: Record<string, string> = {
      no_current: '当前北京时间未落在任何已核实校历内。请更新校历，或用 --semester 明确选择已收录的学期。',
      ambiguous: '有多个校历匹配当前日期，请用 --semester 明确选择。',
      unknown_semester: '尚未收录这个学期的官方校历，请先补充校历配置。',
      exists: '目标配置已存在且内容不同，已保留。请用 npm run status 查看，或用 --output 选择新的配置文件。',
      catalogue: '校历资料不完整，请检查 config/semesters.json 及对应校历文件。',
    };
    console.error(error instanceof SetupError ? messages[error.code] : '初始化失败，请检查命令参数、系统时间及校历配置。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
