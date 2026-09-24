import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { importSchedule } from '../application/import.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { DocumentError, writeScheduleYaml, type ScheduleDocument } from '../schedule/document.js';
import { createPrivateFile, optionalRead, readCalendar, reportLocalError, withLock } from './local-data.js';

export async function pullFile(options: {
  output: string; overwrite: boolean; load: () => Promise<ScheduleDocument>; assertAllowed: () => void; backups?: string;
}): Promise<ScheduleDocument> {
  const output = resolve(options.output);
  return withLock(`${output}.lock`, async () => {
    const before = await optionalRead(output);
    if (before && !options.overwrite) throw new DocumentError('$', '课表已存在；重新拉取须显式使用 --overwrite（会备份并覆盖手工修改）');
    const document = await options.load();
    const content = writeScheduleYaml(document);
    const current = await optionalRead(output);
    if (before === null ? current !== null : current === null || !before.equals(current)) throw new DocumentError('$', '拉取期间课表被修改，已停止覆盖');
    options.assertAllowed();
    if (before !== null) {
      const backups = resolve(options.backups ?? 'data/backups');
      await mkdir(backups, { recursive: true, mode: 0o700 });
      const name = `${basename(output)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}.bak`;
      await writeFile(resolve(backups, name), before, { mode: 0o600, flag: 'wx' });
      const temporary = `${output}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        const latest = await optionalRead(output);
        if (!latest?.equals(before)) throw new DocumentError('$', '拉取期间课表被修改，已停止覆盖');
        options.assertAllowed();
        await rename(temporary, output);
      } finally { await rm(temporary, { force: true }); }
    } else {
      options.assertAllowed();
      await createPrivateFile(output, content);
    }
    return document;
  });
}
export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ strict: true, options: {
      config: { type: 'string', default: 'config/calendar.json' }, output: { type: 'string', default: 'data/schedule.yaml' },
      overwrite: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) { console.log('npm run schedule:pull [-- --overwrite --config config/calendar.json --output data/schedule.yaml]'); return; }
    const credentials = { username: process.env.PKU_USERNAME ?? '', password: process.env.PKU_PASSWORD ?? '' };
    const dependencies = { fetch, now: () => new Date() };
    const { config } = await readCalendar(values.config);
    const load = () => importSchedule(config, credentials, dependencies);
    const assertAllowed = () => assertGenerationAllowed(config, dependencies.now());
    const result = await pullFile({ output: values.output, overwrite: values.overwrite === true, load, assertAllowed });
    const pending = result.courses.flatMap(c => c.slots).filter(s => s.status === 'pending').length;
    console.log(`课表已保存；待处理时段：${pending}。请编辑后运行 npm run schedule:check。`);
  } catch (error) { reportLocalError(error); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
