import { authScenario } from './auth-scenario.js';
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json(await authScenario(await request.text()));
  },
};
