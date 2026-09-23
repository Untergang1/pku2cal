import { IAAA } from '../../src/pku/auth.js';
import { RESULTS } from '../../src/pku/elective.js';
import type { Fetch } from '../../src/pku/http.js';

export function upstream(publicKey: string, html: string): Fetch {
  return async url => {
    if (url === `${IAAA}/getPublicKey.do`) return Response.json({ success: true, key: publicKey });
    if (url === `${IAAA}/oauthlogin.do`) return Response.json({ success: true, token: 'test' });
    if (url === RESULTS) return new Response(html);
    if (new URL(url).pathname.endsWith('/ssoLogin.do')) return new Response('synthetic main page');
    throw new Error('Unexpected synthetic request');
  };
}
