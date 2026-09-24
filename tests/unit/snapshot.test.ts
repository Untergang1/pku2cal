import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, MAX_ENCODED_BYTES, MAX_SNAPSHOT_BYTES, snapshotDigest } from '../../src/application/snapshot.js';
import { generateFromHtml } from '../fixtures/pipeline.js';
import { config, timetable } from '../fixtures/timetable.js';
const token = Buffer.alloc(32, 1).toString('base64url');
const snapshot = generateFromHtml(timetable(), config, new Date('2026-09-24'));
it('binds a single secret to both the exact content and subscription token', () => {
  const payload = encodeSnapshot(snapshot, token);
  expect(decodeSnapshot(payload.encoded, payload.digest)).toEqual({ ...snapshot, token, version: 1 });
  const other = encodeSnapshot(snapshot, Buffer.alloc(32, 2).toString('base64url'));
  expect(() => decodeSnapshot(other.encoded, payload.digest)).toThrow('mismatched');
});
it.each(['broken', 'a'.repeat(MAX_ENCODED_BYTES + 1)])('rejects invalid payload without echoing it %#', encoded => {
  expect(() => decodeSnapshot(encoded, snapshotDigest(encoded))).toThrow('snapshot:invalid_or_mismatched');
});
it('bounds decompression and rejects oversized valid calendars before upload', () => {
  const encoded = gzipSync('x'.repeat(MAX_SNAPSHOT_BYTES + 1)).toString('base64');
  expect(() => decodeSnapshot(encoded, snapshotDigest(encoded))).toThrow();
  const large = { ...snapshot, ics: snapshot.ics.replace('END:VCALENDAR', `X-NOISE:${randomBytes(60_000).toString('hex')}\r\nEND:VCALENDAR`) };
  expect(() => encodeSnapshot(large, token)).toThrow('too_large');
});
