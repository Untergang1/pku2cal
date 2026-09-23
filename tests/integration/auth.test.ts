import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { authScenario } from '../fixtures/auth-scenario.js';
import { workerRuntime } from './runtime.js';
import { Session, PkuError } from '../../src/pku/http.js';
import { authenticate } from '../../src/pku/auth.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let mf: Miniflare | undefined;
afterAll(async () => { await mf?.dispose(); });

describe('authentication protocol in both runtimes', () => {
  for (const runtime of ['node', 'worker']) it(runtime, async () => {
    let result: Awaited<ReturnType<typeof authScenario>>;
    if (runtime === 'node') result = await authScenario(pem);
    else {
      mf = await workerRuntime('tests/fixtures/auth-worker.ts');
      result = await (await mf.dispatchFetch('http://localhost/', { method: 'POST', body: pem })).json() as typeof result;
    }
    expect(result.html).toContain('synthetic timetable');
    expect(result.calls).toBe(5);
    // Inspect the padded block without relying on OpenSSL's PKCS#1 decryption policy.
    const block = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(result.encrypted, 'base64'));
    expect([...block.subarray(0, 2)]).toEqual([0, 2]);
    const separator = block.indexOf(0, 2);
    expect(separator).toBeGreaterThanOrEqual(10);
    expect(block.subarray(separator + 1).toString('utf8')).toBe('密码-test');
  });
});

it('rejects an unexpected redirect without sending a token elsewhere', async () => {
  let calls = 0;
  const session = new Session(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://example.com/leak' } });
  });
  await expect(session.request('https://elective.pku.edu.cn/')).rejects.toMatchObject({ code: 'redirect' });
  expect(calls).toBe(1);
});

it('bounds redirects and recognizes expired sessions', async () => {
  let calls = 0;
  const session = new Session(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: '/loop' } });
  });
  await expect(session.request('https://elective.pku.edu.cn/')).rejects.toBeInstanceOf(PkuError);
  expect(calls).toBe(6);
  await expect(session.request('https://iaaa.pku.edu.cn/iaaa/oauth.jsp', {}, true)).rejects.toMatchObject({ code: 'session_expired' });
});

it('reports interactive verification without exposing upstream messages', async () => {
  await expect(authenticate({ username: 'synthetic', password: 'secret' }, async url => {
    if (url.endsWith('getPublicKey.do')) return Response.json({ success: true, key: pem });
    return Response.json({ success: false, errors: { msg: '需要验证码 secret' } });
  })).rejects.toEqual(new PkuError('interaction_required'));
});

it('removes request bodies on POST-to-GET redirects and scopes cookies by path', async () => {
  const session = new Session(async (url, init) => {
    if (url.endsWith('/post')) return new Response(null, { status: 303, headers: { location: '/other', 'set-cookie': 'restricted=x; Path=/post' } });
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    return new Response('ok');
  });
  expect((await session.request('https://iaaa.pku.edu.cn/post', { method: 'POST', body: 'synthetic' })).body).toBe('ok');
});
