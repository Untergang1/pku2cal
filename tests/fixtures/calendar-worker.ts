import { createWorker, type WorkerEnv } from '../../src/entrypoints/worker.js';
import { config, timetable } from './timetable.js';
import { upstream } from './upstream.js';

let worker: ReturnType<typeof createWorker> | undefined;
export default {
  async fetch(request: Request, env: WorkerEnv & { TEST_PUBLIC_KEY: string; TEST_CONFIG?: string; TEST_HTML?: string }): Promise<Response> {
    worker ??= createWorker(env.TEST_CONFIG ? JSON.parse(env.TEST_CONFIG) : config, {
      fetch: upstream(env.TEST_PUBLIC_KEY, env.TEST_HTML ?? timetable()), now: () => new Date('2026-09-01T00:00:00Z'), log: () => {},
    });
    return worker.fetch(request, env);
  },
};
