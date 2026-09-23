import { CookieJar } from 'tough-cookie';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PkuErrorCode = 'credentials' | 'interaction_required' | 'authentication' | 'session_expired' | 'network' | 'redirect' | 'response' | 'public_key';

/** Deliberately never retains upstream bodies, URLs, or native exception causes. */
export class PkuError extends Error {
  constructor(public readonly code: PkuErrorCode) {
    super(`pku:${code}`);
    this.name = 'PkuError';
  }
}

export interface Page {
  url: URL;
  body: string;
}

const origins = new Set(['https://iaaa.pku.edu.cn', 'https://elective.pku.edu.cn']);

function checkedUrl(input: string, base?: URL): URL {
  const url = new URL(input, base);
  // The documented SSO callback uses HTTP. Send its request over HTTPS instead.
  if (url.origin === 'http://elective.pku.edu.cn') url.protocol = 'https:';
  if (!origins.has(url.origin) || url.username || url.password) throw new PkuError('redirect');
  return url;
}

/** An in-memory session for one generation only. Redirects never bypass the jar. */
export class Session {
  private readonly jar = new CookieJar();
  constructor(private readonly fetcher: Fetch, private readonly timeoutMs = 15000) {}

  async request(input: string, init: RequestInit = {}, rejectLogin = false): Promise<Page> {
    let url = checkedUrl(input);
    let method = init.method ?? 'GET';
    let body = init.body;
    const headers = new Headers(init.headers);
    headers.set('user-agent', 'pku2cal/0.1');
    for (let hop = 0; hop <= 5; hop++) {
      if (rejectLogin && (url.hostname === 'iaaa.pku.edu.cn' || /(?:ssoLogin|login)\./i.test(url.pathname))) {
        throw new PkuError('session_expired');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const cookie = await this.jar.getCookieString(url.href);
        headers.delete('cookie');
        if (cookie) headers.set('cookie', cookie);
        // Worker fetch is a Web IDL function: invoking it as a Session method
        // supplies an illegal receiver. Node fetch happens to tolerate that.
        const fetcher = this.fetcher;
        const response = await fetcher(url.href, {
          method, ...(body !== undefined ? { body } : {}), headers,
          redirect: 'manual', signal: controller.signal,
        });
        for (const cookie of response.headers.getSetCookie()) {
          await this.jar.setCookie(cookie, url.href);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || hop === 5) throw new PkuError('redirect');
          const next = checkedUrl(location, url);
          // Never forward a password POST to another origin, even if allowlisted.
          if (next.origin !== url.origin && method !== 'GET') throw new PkuError('redirect');
          if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
            method = 'GET';
            body = undefined;
            headers.delete('content-type');
          }
          url = next;
          continue;
        }
        if (response.status === 401 || response.status === 403) throw new PkuError(rejectLogin ? 'session_expired' : 'authentication');
        if (!response.ok) throw new PkuError('response');
        const bytes = await response.arrayBuffer();
        const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? 'utf-8';
        const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
        if (rejectLogin && /(?:oauthlogin|name\s*=\s*["'](?:password|userName)["']|统一身份认证)/i.test(text)) {
          throw new PkuError('session_expired');
        }
        return { url, body: text };
      } catch (error) {
        if (error instanceof PkuError) throw error;
        throw new PkuError('network');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new PkuError('redirect');
  }
}
