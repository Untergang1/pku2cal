import { constants, publicEncrypt } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { load } from 'cheerio/slim';
import { PkuError, Session, type Fetch } from './http.js';

export interface Credentials { username: string; password: string }
export const IAAA = 'https://iaaa.pku.edu.cn/iaaa';
export const SSO = 'https://elective.pku.edu.cn/elective2008/ssoLogin.do';
export const OAUTH_REDIRECT = 'http://elective.pku.edu.cn:80/elective2008/ssoLogin.do';

export function encryptPassword(pem: string, password: string): string {
  try {
    return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64');
  } catch {
    throw new PkuError('public_key');
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* sanitized below */ }
  throw new PkuError('response');
}

export async function authenticate(credentials: Credentials, fetcher: Fetch): Promise<Session> {
  if (!credentials.username.trim() || !credentials.password) throw new PkuError('credentials');
  const session = new Session(fetcher);
  const ajax = { 'x-requested-with': 'XMLHttpRequest', referer: `${IAAA}/oauth.jsp` };
  const key = parseObject((await session.request(`${IAAA}/getPublicKey.do`, { headers: ajax })).body);
  if (key.success !== true || typeof key.key !== 'string') throw new PkuError('public_key');
  const form = new URLSearchParams({
    appid: 'syllabus', userName: credentials.username,
    password: encryptPassword(key.key, credentials.password),
    randCode: '', smsCode: '', otpCode: '', redirUrl: OAUTH_REDIRECT,
  });
  const login = parseObject((await session.request(`${IAAA}/oauthlogin.do`, {
    method: 'POST', headers: { ...ajax, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  })).body);
  if (login.success !== true) {
    const errorText = JSON.stringify(login.errors ?? {});
    if (/otp|sms|captcha|验证码|手机令牌|动态口令|扫码/i.test(errorText)) throw new PkuError('interaction_required');
    throw new PkuError('authentication');
  }
  if (typeof login.token !== 'string' || !login.token) throw new PkuError('response');
  const url = new URL(SSO);
  url.searchParams.set('token', login.token);
  url.searchParams.set('_rand', String(Math.random()));
  let page = await session.request(url.href);
  const $ = load(page.body);
  const majorLinks = $('a[href]').toArray().map(a => $(a).attr('href')!).filter(href => /[?&]sttp=bzx(?:&|$)/.test(href));
  if (majorLinks.length > 0) {
    if (majorLinks.length !== 1) throw new PkuError('response');
    const major = new URL(majorLinks[0]!, page.url);
    if (major.origin !== new URL(SSO).origin || major.pathname !== new URL(SSO).pathname || !major.searchParams.get('sida')) throw new PkuError('response');
    page = await session.request(major.href);
  } else if (($('#div1').length && $('#div2').length) || /[?&]sttp=bfx/.test(page.body)) {
    throw new PkuError('response');
  }
  if (page.url.hostname === 'iaaa.pku.edu.cn' || /oauthlogin|统一身份认证|name\s*=\s*["']password["']/i.test(page.body)) throw new PkuError('authentication');
  return session;
}
