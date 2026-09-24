import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const configDirectory = resolve('.cache/wrangler-config');
mkdirSync(configDirectory, { recursive: true });
const cli = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
const result = spawnSync(process.execPath, [cli, 'deploy', '--dry-run', '--outdir', '.cache/worker-check'], {
  stdio: 'inherit', env: {
    ...process.env, PKU_CONFIG_PATH: 'config/calendar.example.json',
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: resolve('.cache/wrangler-logs'),
    XDG_CONFIG_HOME: configDirectory,
    // Never load private local secrets into a build/dry-run.
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  },
});
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  // Exercise the one-command setup's actual generated config and secrets-file interface on both CI systems.
  const { deploymentConfig } = await import('../dist/entrypoints/worker-setup.js');
  const { workerCommand } = await import('../dist/entrypoints/worker-cloudflare.js');
  const { saveWorkerFile } = await import('../dist/entrypoints/worker-state.js');
  const { parse } = await import('jsonc-parser');
  const directory = await mkdtemp(resolve('.cache/worker-setup-check-'));
  try {
    const config = deploymentConfig(parse(await readFile('wrangler.jsonc', 'utf8')), 'pku2cal-check', 'a'.repeat(32), 'b'.repeat(32));
    const configPath = resolve(directory, 'wrangler.json');
    const secretsPath = resolve(directory, 'secrets.json');
    await saveWorkerFile(configPath, JSON.stringify(config));
    await saveWorkerFile(secretsPath, JSON.stringify({ PKU_USERNAME: 'synthetic', PKU_PASSWORD: 'synthetic',
      PKU_UNSCHEDULED_COURSES: '[]', CALENDAR_TOKEN: 't'.repeat(43) }));
    await workerCommand(directory, { ...process.env, XDG_CONFIG_HOME: configDirectory })([
      'deploy', '--dry-run', '--config', configPath, '--secrets-file', secretsPath, '--outdir', resolve(directory, 'output'),
    ], { PKU_CONFIG_PATH: resolve('config/calendar.example.json') });
    console.log('Worker setup generated config and synthetic secrets: dry-run passed.');
  } catch {
    console.error('Worker setup generated config dry-run failed.');
    process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
