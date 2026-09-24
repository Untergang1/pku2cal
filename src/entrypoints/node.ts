import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateCalendar, type GeneratedCalendar } from '../application/generate.js';
import { semesterStatus } from '../application/setup.js';
import { savePagesState } from './pages-state.js';
import { readCalendar, readLocalSnapshot, reportLocalError } from './local-data.js';

export async function generateFile(options: { config: unknown; document: unknown; output: string; now: Date }): Promise<GeneratedCalendar> {
  const result = generateCalendar(options.document, options.config, options.now);
  await savePagesState(resolve(options.output), result.ics);
  return result;
}
export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: {
      config: { type: 'string', default: 'config/calendar.json' }, schedule: { type: 'string', default: 'data/schedule.yaml' },
      output: { type: 'string', default: 'data/calendar.ics' }, check: { type: 'boolean' }, status: { type: 'boolean' }, help: { type: 'boolean' },
    }, strict: true });
    if (values.help) {
      console.log('用法：npm run generate [-- --config config/calendar.json --schedule data/schedule.yaml --output data/calendar.ics]\nnpm run schedule:check 仅验证本地课表；npm run status 显示校历与拉取日期状态。所有操作均不登录北大。');
      return;
    }
    if (values.status) {
      const selected = await readCalendar(values.config);
      console.log(`时间表：${selected.label}（${selected.source.timetable}）`);
      for (const line of semesterStatus(selected.config, new Date())) console.log(line);
      console.log('本地课表的生成和发布不受当前日期限制。');
      return;
    }
    const snapshot = await readLocalSnapshot(values);
    if (!values.check) await savePagesState(resolve(values.output), snapshot.ics);
    console.log(values.check ? '本地课表检查通过。' : '本地日历生成成功。');
  } catch (error) { reportLocalError(error); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
