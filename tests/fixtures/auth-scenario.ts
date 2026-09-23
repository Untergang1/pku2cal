import { IAAA, SSO, OAUTH_REDIRECT } from '../../src/pku/auth.js';
import { RESULTS, fetchTimetable } from '../../src/pku/elective.js';
import type { Fetch } from '../../src/pku/http.js';

/** Synthetic protocol fixture. No actual university requests or personal data. */
export async function authScenario(publicKey: string): Promise<{ html: string; encrypted: string; calls: number }> {
  let calls = 0;
  let encrypted = '';
  const fake: Fetch = async (input, init) => {
    calls++;
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    if (init?.redirect !== 'manual') throw new Error('redirect policy');
    if (input === `${IAAA}/getPublicKey.do`) return Response.json({ success: true, key: publicKey }, { headers: { 'set-cookie': 'iaaa=a; Path=/; Secure' } });
    if (input === `${IAAA}/oauthlogin.do`) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('appid') !== 'syllabus' || form.get('redirUrl') !== OAUTH_REDIRECT || headers.get('cookie') !== 'iaaa=a') throw new Error('oauth contract');
      encrypted = form.get('password')!;
      return Response.json({ success: true, token: 'synthetic-token' });
    }
    if (url.pathname === new URL(SSO).pathname) {
      if (headers.has('cookie')) throw new Error('cross-origin cookie leak');
      const headersOut = new Headers({ location: '/elective2008/home' });
      headersOut.append('set-cookie', 'session=b; Path=/elective2008; Secure; HttpOnly');
      headersOut.append('set-cookie', 'detail=c; Path=/elective2008; Secure');
      return new Response(null, { status: 302, headers: headersOut });
    }
    if (!headers.get('cookie')?.includes('session=b') || !headers.get('cookie')?.includes('detail=c')) throw new Error('missing cookies');
    if (url.pathname === '/elective2008/home') return new Response('<h1>主修选课</h1>');
    if (input === RESULTS) return new Response('<h1>synthetic timetable</h1>');
    throw new Error('unexpected request');
  };
  const html = await fetchTimetable({ username: 'synthetic', password: '密码-test' }, fake);
  return { html, encrypted, calls };
}
