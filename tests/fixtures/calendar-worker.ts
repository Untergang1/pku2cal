import { createWorker, type WorkerEnv } from '../../src/entrypoints/worker.js';
import { config, timetable } from './timetable.js';
import { upstream } from './upstream.js';

let worker: ReturnType<typeof createWorker> | undefined;
export default {
  async fetch(request: Request, env: WorkerEnv & { TEST_PUBLIC_KEY: string }): Promise<Response> {
    worker ??= createWorker(config, {
      fetch: upstream(env.TEST_PUBLIC_KEY, timetable()), now: () => new Date('2026-09-01T00:00:00Z'), log: () => {},
    });
    return worker.fetch(request, env);
  },
};
