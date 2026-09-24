import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SupplementError } from './supplements.js';

/** Read archived private sources only during explicit one-time migration. */
export async function readPrivateSupplements(
  inline: string | undefined, file: string | undefined,
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<string | undefined> {
  if (!file?.trim()) return inline;
  if (inline?.trim()) throw new SupplementError('invalid');
  try {
    const json = await read(resolve(file));
    if (!json.trim()) throw new SupplementError('invalid');
    return json;
  } catch { throw new SupplementError('invalid'); }
}
