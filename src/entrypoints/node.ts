import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateCalendar, type GenerationDependencies, type GeneratedCalendar } from '../application/generate.js';
import { errorCategory, logRecord } from '../application/log.js';
import type { Credentials } from '../pku/auth.js';
import { configWithPrivateConfirmations, validateConfig } from '../application/config.js';
import { assertGenerationAllowed } from '../application/semester.js';

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
    const { values } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' } }, strict: true });
    if (!values.config || !values.output) {
      console.error('Usage: npm run generate -- --config <json> --output <ics>');
      process.exitCode = 1;
      return;
    }
    const config = configWithPrivateConfirmations(JSON.parse(await readFile(resolve(values.config), 'utf8')), process.env.PKU_UNSCHEDULED_COURSES);
    await generateFile({ config, output: values.output, credentials: {
      username: process.env.PKU_USERNAME ?? '', password: process.env.PKU_PASSWORD ?? '',
    }, dependencies: { fetch, now: () => new Date() } });
    logRecord({ stage: 'generate', category: 'success', durationMs: Date.now() - started });
  } catch (error) {
    logRecord({ stage: 'generate', category: errorCategory(error), durationMs: Date.now() - started });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
