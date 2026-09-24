import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function validatePagesToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new Error('pages:invalid_token');
  }
  return token;
}

export const newPagesToken = () => randomBytes(32).toString('base64url');

export function subscriptionUrl(base: string, token: string): string {
  validatePagesToken(token);
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('pages:invalid_url');
  url.pathname = url.pathname.replace(/\/?$/, '/') + `${token}/calendar.ics`;
  return url.href;
}

export async function savePagesState(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
