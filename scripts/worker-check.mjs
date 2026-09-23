import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
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
