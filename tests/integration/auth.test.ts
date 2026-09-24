import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authScenario } from '../fixtures/auth-scenario.js';
import { Session, PkuError } from '../../src/pku/http.js';
import { authenticate } from '../../src/pku/auth.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
describe('authentication protocol in Node', () => {
  it('authenticates with an isolated session', async () => {
    const result = await authScenario(pem);
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

it('does not bind the injected fetch function to the session instance', async () => {
  const session = new Session(async function (this: unknown) {
    expect(this).toBeUndefined();
    return new Response('ok');
  });
  expect((await session.request('https://iaaa.pku.edu.cn/')).body).toBe('ok');
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

it('reports timeouts as sanitized network failures', async () => {
  const session = new Session(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('private URL and request')), { once: true });
  }), 5);
  await expect(session.request('https://iaaa.pku.edu.cn/')).rejects.toEqual(new PkuError('network'));
});

it('keeps each generation session independent', async () => {
  const first = new Session(async () => new Response('ok', { headers: { 'set-cookie': 'first=private; Path=/' } }));
  await first.request('https://iaaa.pku.edu.cn/');
  const second = new Session(async (_url, init) => {
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    return new Response('ok');
  });
  await second.request('https://iaaa.pku.edu.cn/');
});
