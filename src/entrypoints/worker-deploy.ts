import { createWorker, type WorkerEnv } from './worker.js';

// The deployment module exposes only a handler; workerd treats named exports as entrypoints.
declare const __CALENDAR_CONFIG__: unknown;
let deployed: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    deployed ??= createWorker(__CALENDAR_CONFIG__);
    return deployed.fetch(request, env);
  },
};
