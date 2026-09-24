import type { GeneratedCalendar } from '../application/generate.js';
import { createWorker, type WorkerEnv } from './worker.js';

// The deployment module exposes only a handler; workerd treats named exports as entrypoints.
declare const __CALENDAR_SNAPSHOT__: GeneratedCalendar;
let deployed: ReturnType<typeof createWorker> | undefined;
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    deployed ??= createWorker(__CALENDAR_SNAPSHOT__);
    return deployed.fetch(request, env);
  },
};
