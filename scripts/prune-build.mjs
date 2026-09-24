import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Only nested TypeScript outputs are managed here; root bundles stay intact.
const output = resolve('dist');
const source = resolve('src');
async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function prune(relative) {
  const directory = join(output, relative);
  for (const entry of await entries(directory)) {
    const file = join(relative, entry.name);
    if (entry.isDirectory()) await prune(file);
    else if (entry.isFile() && /(?:\.js(?:\.map)?|\.d\.ts)$/.test(entry.name)) {
      const original = join(source, file.replace(/(?:\.js(?:\.map)?|\.d\.ts)$/, '.ts'));
      try { await stat(original); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await rm(join(output, file));
      }
    }
  }
  if ((await entries(directory)).length === 0) await rmdir(directory);
}
for (const entry of await entries(output)) {
  if (entry.isDirectory()) await prune(entry.name);
}
