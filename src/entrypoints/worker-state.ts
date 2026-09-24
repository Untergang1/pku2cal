import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const cloudflareId = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== '0'.repeat(32));
export const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const workerToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
export const workerState = z.object({
  accountId: cloudflareId, name: workerName, token: workerToken, namespaceId: cloudflareId.optional(),
}).strict();
export const newWorkerToken = () => randomBytes(32).toString('base64url');

/** Persist the token before any remote mutation, including a rotation. */
export async function saveWorkerFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
