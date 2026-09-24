import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { saveWorkerFile } from '../dist/entrypoints/worker-state.js';
import { readLocalSnapshot } from '../dist/entrypoints/local-data.js';
import { validateSnapshot } from '../dist/application/snapshot.js';

try {
  const snapshot = validateSnapshot(process.env.PKU_SNAPSHOT_PATH
    ? JSON.parse(await readFile(process.env.PKU_SNAPSHOT_PATH, 'utf8'))
    : await readLocalSnapshot({ config: process.env.PKU_CONFIG_PATH, schedule: process.env.PKU_SCHEDULE_PATH }));
  const bundle = await build({
    entryPoints: ['src/entrypoints/worker-deploy.ts'], outfile: 'dist/worker.mjs', bundle: true, write: false, logLevel: 'silent',
    format: 'esm', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'],
    conditions: ['workerd', 'browser'], external: ['node:*'],
    define: { __CALENDAR_SNAPSHOT__: JSON.stringify(snapshot) },
  });
  await saveWorkerFile('dist/worker.mjs', bundle.outputFiles[0].text);
} catch {
  console.error('worker-build:invalid (run schedule:check; a valid local schedule and calendar are required)');
  process.exitCode = 1;
}
