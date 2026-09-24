import { readFile, mkdir, rm, link } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCalendarConfig } from './calendar-config.js';
import { savePrivateFile } from './private-files.js';
import { fileURLToPath } from 'node:url';
import { DocumentError, readScheduleYaml } from '../schedule/document.js';
import { generateCalendar } from '../application/generate.js';
import { TimetableConfigError } from '../application/config.js';
import { errorCategory } from '../application/log.js';
import { SnapshotError } from '../application/snapshot.js';

export type ReadFile = (path: string) => Promise<string>;
export const readText: ReadFile = path => readFile(resolve(path), 'utf8');
export async function readCalendar(path = 'config/calendar.json', read = readText) {
  let source: unknown;
  try { source = JSON.parse(await read(path)); }
  catch { throw new TimetableConfigError('无法读取校历 JSON。请先运行 npm run setup，或用 --config 指定校历。'); }
  return resolveCalendarConfig(source, file => read(fileURLToPath(file)));
}
export async function readLocalSnapshot(options: { config?: string | undefined; schedule?: string | undefined }, read = readText, now = new Date()) {
  const selected = await readCalendar(options.config, read);
  let yaml: string;
  try { yaml = await read(options.schedule ?? 'data/schedule.yaml'); }
  catch { throw new DocumentError('$', '无法读取课表文件，请先运行 npm run schedule:pull 或检查 --schedule 路径'); }
  return generateCalendar(readScheduleYaml(yaml), selected.config, now);
}
export function reportLocalError(error: unknown): void {
  if (error instanceof DocumentError) console.error(error.message);
  else if (error instanceof SnapshotError) console.error(error.guidance);
  else if (error instanceof TimetableConfigError) console.error(error.guidance);
  else console.error(`操作失败：${errorCategory(error)}；已有文件未替换，请检查配置、参数和输入。`);
}
export async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new DocumentError('$', '存在操作锁，请确认没有运行中的任务后再清理遗留锁'); }
  try { return await run(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
export async function optionalRead(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
/** link is an atomic, no-clobber initial install on both macOS and Linux. */
export async function createPrivateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await savePrivateFile(temporary, content); await link(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
