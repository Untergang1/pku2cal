import { readFile } from 'node:fs/promises';
import { TimetableConfigError, validateConfig, validateSourceConfig, validateTimetable, type TimetableId } from '../application/config.js';

const timetableFiles: Record<TimetableId, URL> = {
  'pku-main': new URL('../../config/timetables/pku-main.json', import.meta.url),
  'pku-ss': new URL('../../config/timetables/pku-ss.json', import.meta.url),
};
export type ReadTimetable = (file: URL) => Promise<string>;

/** Only the selected table is read; paths are independent of cwd and calendar location. */
export async function resolveCalendarConfig(input: unknown, read: ReadTimetable = file => readFile(file, 'utf8')) {
  const source = validateSourceConfig(input);
  const { timetable, ...calendar } = source;
  let table: ReturnType<typeof validateTimetable>;
  try {
    table = validateTimetable(JSON.parse(await read(timetableFiles[timetable])));
  } catch {
    throw new TimetableConfigError(`请填写或修正 config/timetables/${timetable}.json：文件须存在，label 非空，periods 须包含有效且不重叠的节次起止时间。`);
  }
  return { source, label: table.label, config: validateConfig({ ...calendar, periods: table.periods }) };
}
