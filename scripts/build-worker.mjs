import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { validateConfig } from '../dist/application/config.js';

try {
  const path = resolve(process.env.PKU_CONFIG_PATH || 'config/calendar.json');
  const config = validateConfig(JSON.parse(await readFile(path, 'utf8')));
  await build({
    entryPoints: ['src/entrypoints/worker.ts'], outfile: 'dist/worker.mjs', bundle: true,
    format: 'esm', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'],
    conditions: ['workerd', 'browser'], external: ['node:*'],
    define: { __CALENDAR_CONFIG__: JSON.stringify(config) },
  });
} catch {
  console.error('worker-build:invalid (set PKU_CONFIG_PATH to a valid calendar JSON file)');
  process.exitCode = 1;
}
