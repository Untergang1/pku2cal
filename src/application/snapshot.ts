import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { calendarIdentity } from '../calendar/compare.js';
import type { GeneratedCalendar } from './generate.js';

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_ENCODED_BYTES = 45 * 1024;
export class SnapshotError extends Error {
  constructor(code: 'invalid' | 'too_large' | 'invalid_or_mismatched') {
    super(`snapshot:${code}`);
    this.guidance = code === 'too_large'
      ? '发布快照过大：Pages 编码上限为 45 KiB，快照 JSON 上限为 2 MiB；尚未上传。'
      : '发布快照无效或与本次摘要不一致，请从本地课表重新发布。';
  }
  readonly guidance: string;
}
export const snapshotSchema = z.strictObject({ ics: z.string(), generatedAt: z.iso.datetime() });
const envelope = snapshotSchema.extend({ version: z.literal(1), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export function validateSnapshot(input: unknown): GeneratedCalendar {
  const result = snapshotSchema.safeParse(input);
  if (!result.success) throw new SnapshotError('invalid');
  if (Buffer.byteLength(JSON.stringify(result.data)) > MAX_SNAPSHOT_BYTES) throw new SnapshotError('too_large');
  calendarIdentity(result.data.ics);
  return result.data;
}
export const snapshotDigest = (encoded: string) => createHash('sha256').update(encoded).digest('hex');
export function encodeSnapshot(snapshot: GeneratedCalendar, token: string): { encoded: string; digest: string } {
  const data = envelope.safeParse({ version: 1, token, ...validateSnapshot(snapshot) });
  if (!data.success || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new SnapshotError('invalid');
  const content = JSON.stringify(data.data);
  if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new SnapshotError('too_large');
  const encoded = gzipSync(content).toString('base64');
  if (encoded.length > MAX_ENCODED_BYTES) throw new SnapshotError('too_large');
  return { encoded, digest: snapshotDigest(encoded) };
}
export function decodeSnapshot(encoded: string, expectedDigest: string) {
  try {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest) || encoded.length > MAX_ENCODED_BYTES || snapshotDigest(encoded) !== expectedDigest) throw new Error();
    const binary = Buffer.from(encoded, 'base64');
    if (binary.toString('base64') !== encoded) throw new Error();
    const data = envelope.parse(JSON.parse(gunzipSync(binary, { maxOutputLength: MAX_SNAPSHOT_BYTES }).toString('utf8')));
    if (Buffer.from(data.token, 'base64url').toString('base64url') !== data.token) throw new Error();
    validateSnapshot({ ics: data.ics, generatedAt: data.generatedAt });
    return data;
  } catch { throw new SnapshotError('invalid_or_mismatched'); }
}
