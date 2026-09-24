import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SupplementError } from '../schedule/supplements.js';

/** File access stays in Node entrypoints; Worker receives JSON through its Secret. */
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
