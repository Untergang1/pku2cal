import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { importCalendar, type CalendarPullResult } from '../application/calendar-pull.js';
import { validateSourceConfig, type CalendarSourceConfig } from '../application/config.js';
import { CALENDAR_URL, CalendarPullError } from '../pku/academic-calendar.js';
import { createPrivateFile, optionalRead, withLock } from './local-data.js';
import { resolveCalendarConfig } from './calendar-config.js';

export async function pullCalendarFile(options: {
  output: string; overwrite: boolean; dryRun: boolean; backups?: string;
  load: (previous: CalendarSourceConfig | undefined) => Promise<CalendarPullResult>;
}): Promise<CalendarPullResult> {
  const output = resolve(options.output);
  const run = async () => {
    const before = await optionalRead(output);
    if (before !== null && !options.overwrite && !options.dryRun) throw new CalendarPullError('校历已存在；请先用 --dry-run 预览，或用 --overwrite 备份后整体替换日期（会移除手工修订）。');
    let previous: CalendarSourceConfig | undefined;
    if (before !== null) {
      try { previous = validateSourceConfig(JSON.parse(before.toString('utf8'))); }
      catch { throw new CalendarPullError('现有校历配置损坏，请先修复，或用 --output 另存；原文件已保留。'); }
    }
    const result = await options.load(previous);
    await resolveCalendarConfig(result.config);
    if (options.dryRun) return result;
    const assertUnchanged = async () => {
      const current = await optionalRead(output);
      if (before === null ? current !== null : current === null || !before.equals(current)) throw new CalendarPullError('拉取期间校历被修改，已停止覆盖。');
    };
    await assertUnchanged();
    const content = JSON.stringify(result.config, null, 2) + '\n';
    if (before === null) await createPrivateFile(output, content);
    else {
      const backups = resolve(options.backups ?? 'data/backups');
      await mkdir(backups, { recursive: true, mode: 0o700 });
      const name = `${basename(output)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.bak`;
      await writeFile(resolve(backups, name), before, { mode: 0o600, flag: 'wx' });
      const temporary = `${output}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await assertUnchanged();
        await rename(temporary, output);
      } finally { await rm(temporary, { force: true }); }
    }
    return result;
  };
  return options.dryRun ? run() : withLock(`${output}.lock`, run);
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ strict: true, options: {
      output: { type: 'string', default: 'config/calendar.json' }, semester: { type: 'string' },
      overwrite: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('npm run calendar:pull [-- --semester 2026-2027-1 --output config/calendar.json --overwrite --dry-run]\n手动抓取校本部校历；--dry-run 仅预览，--overwrite 备份后整体替换日期并移除手工修订。');
      return;
    }
    const result = await pullCalendarFile({ output: values.output, overwrite: values.overwrite === true, dryRun: values['dry-run'] === true,
      load: previous => importCalendar({ ...(previous ? { previous } : {}), ...(values.semester ? { semester: values.semester } : {}), fetch, now: new Date() }),
    });
    console.log(`校历来源：${CALENDAR_URL}\n校本部学期：${result.config.semester}`);
    console.log(result.changes.length ? result.changes.join('\n') : '校历字段无变化。');
    for (const notice of result.notices) console.log(`待核对：${notice}`);
    console.log(values['dry-run'] ? `预览完成，未写文件。目标：${values.output}` : `校历已保存：${values.output}；已有原文件备份在 data/backups/。`);
    console.log('请核对选课系统学期及待公布安排；校历不包含学院临时通知。手工日期修订须重新补充，本地变更需重新生成并发布才会影响订阅。');
  } catch (error) {
    console.error(error instanceof CalendarPullError ? error.guidance : '校历拉取失败，请检查参数、配置、作息表或文件权限；已有校历未替换。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
