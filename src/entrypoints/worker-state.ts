import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const cloudflareId = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== '0'.repeat(32));
export const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const workerToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
export const workerState = z.object({
  accountId: cloudflareId, name: workerName, token: workerToken,
}).strict();
export const newWorkerToken = () => randomBytes(32).toString('base64url');
