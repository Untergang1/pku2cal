import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';

export async function workerRuntime(entry: string, env?: MiniflareOptions['workers'][number]['config']['env']): Promise<Miniflare> {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['workerd', 'browser'], external: ['node:*'],
  });
  return new Miniflare({
    telemetry: { enabled: false },
    workers: [{ config: {
      name: 'test', compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'],
      ...(env ? { env } : {}),
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: bundle.outputFiles[0]!.text } } },
    } }],
  });
}
