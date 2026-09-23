import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

let runtime;
try {
  const username = process.env.PKU_USERNAME ?? '';
  const password = process.env.PKU_PASSWORD ?? '';
  if (!username || !password) throw new Error();
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { fetchTimetable } from './src/pku/elective.ts';
      import { errorCategory } from './src/application/log.ts';
      export default { async fetch(request, env) {
        try { return new Response(await fetchTimetable({ username: env.USERNAME, password: env.PASSWORD }, fetch)); }
        catch (error) { return new Response(errorCategory(error), { status: 503 }); }
      } };
    ` },
    bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
    conditions: ['workerd', 'browser'], external: ['node:*'],
  });
  runtime = new Miniflare({
    telemetry: { enabled: false }, logRequests: false, log: new Log(LogLevel.NONE),
    workers: [{ config: {
      name: 'private-probe', compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
      env: { USERNAME: { type: 'text', value: username }, PASSWORD: { type: 'text', value: password } },
      manifest: { mainModule: 'probe.js', modules: { 'probe.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
    } }],
  });
  const response = await runtime.dispatchFetch('http://localhost/probe');
  if (!response.ok) {
    const category = await response.text();
    console.error(/^pku:[a-z_]+$/.test(category) ? `worker-probe:${category}` : 'worker-probe:failed');
    process.exitCode = 1;
  } else {
    await mkdir('data', { recursive: true, mode: 0o700 });
    await writeFile('data/upstream-worker.html', await response.text(), { mode: 0o600 });
    console.log('worker-probe:success (private HTML saved under data/)');
  }
} catch {
  console.error('worker-probe:failed');
  process.exitCode = 1;
} finally { await runtime?.dispose(); }
