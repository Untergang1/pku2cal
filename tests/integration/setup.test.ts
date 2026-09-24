import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { selectSemester, semesterStatus } from '../../src/application/setup.js';
import { initializeCalendar, loadPresets } from '../../src/entrypoints/setup.js';
import { resolveCalendarConfig } from '../../src/entrypoints/calendar-config.js';
import { assertGenerationAllowed } from '../../src/application/semester.js';

const now = new Date('2026-09-24T02:00:00Z');
const directories: string[] = [];
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

it('initializes the confirmed autumn semester from the official calendar', async () => {
  const presets = await loadPresets();
  const automatic = selectSemester(presets, now);
  expect(automatic).toEqual(selectSemester(presets, now, '2026-2027-1'));
  expect(automatic.config.semesterBinding).toEqual({ confirmedSemester: '2026-2027-1', validFrom: '2026-09-07', validThrough: '2027-01-10' });
  expect(automatic.config.timetable).toBe('pku-ss');
  expect(automatic.config).not.toHaveProperty('periods');
  expect((await resolveCalendarConfig(automatic.config)).config.periods).toHaveLength(12);
  expect(automatic.config.teachingWeeks).toBe(16);
  expect(automatic.config).not.toHaveProperty('unscheduledCourses');
  expect(() => assertGenerationAllowed(automatic.config, now)).not.toThrow();
});

it.each([
  ['2026-09-06T15:59:59.999Z', false],
  ['2026-09-06T16:00:00.000Z', true],
  ['2027-01-10T15:59:59.999Z', true],
  ['2027-01-10T16:00:00.000Z', false],
])('selects by Shanghai calendar boundaries at %s', async (date, matches) => {
  const presets = await loadPresets();
  const select = () => selectSemester(presets, new Date(date));
  if (matches) expect(select().config.semester).toBe('2026-2027-1');
  else expect(select).toThrow('setup:no_current');
});

it('does not guess a missing or ambiguous calendar or use an invalid clock', async () => {
  const presets = await loadPresets();
  expect(() => selectSemester(presets, now, '2027-2028-1')).toThrow('setup:unknown_semester');
  expect(() => selectSemester([...presets, ...presets], now)).toThrow('setup:ambiguous');
  expect(() => selectSemester(presets, new Date('invalid'))).toThrow('semester:invalid_clock');
});

it('preserves configuration and namespace when setup is rerun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pku2cal-setup-')); directories.push(directory);
  const path = join(directory, 'calendar.json');
  const selection = selectSemester(await loadPresets(), now);
  expect(await initializeCalendar(path, selection.config)).toBe('created');
  expect(await initializeCalendar(path, selection.config)).toBe('unchanged');
  const original = await readFile(path, 'utf8');
  await expect(initializeCalendar(path, { ...selection.config, namespace: 'changed-namespace' })).rejects.toThrow('setup:exists');
  expect(await readFile(path, 'utf8')).toBe(original);
  const custom = JSON.stringify({ ...selection.config, timetable: 'pku-main' });
  await writeFile(path, custom);
  await expect(initializeCalendar(path, selection.config)).rejects.toThrow('setup:exists');
  expect(await readFile(path, 'utf8')).toBe(custom);
  await writeFile(path, 'private invalid draft');
  await expect(initializeCalendar(path, selection.config)).rejects.toThrow('setup:exists');
  expect(await readFile(path, 'utf8')).toBe('private invalid draft');
});

it('explains current, future and expired date status without exposing courses', async () => {
  const config = selectSemester(await loadPresets(), now).config;
  expect(semesterStatus(config, now).join('\n')).toContain('可以拉取');
  expect(semesterStatus(config, new Date('2026-08-01T00:00:00Z')).join('\n')).toContain('尚未开始');
  expect(semesterStatus(config, new Date('2027-01-11T00:00:00Z')).join('\n')).toContain('停止拉取');
  expect(semesterStatus(config, new Date('2026-09-24T16:00:00Z'))[0]).toBe('北京时间：2026-09-25');
});
