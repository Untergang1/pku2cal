import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/prune-build.mjs', import.meta.url));
it('prunes orphaned compiler outputs while preserving source-backed outputs and bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pku-build-'));
  try {
    const files = {
      'src/application/current.ts': 'export const value = 1;',
      'dist/application/current.js': 'current output',
      'dist/application/current.js.map': 'current map',
      'dist/application/current.d.ts': 'current declaration',
      'dist/application/removed.js': 'orphan output',
      'dist/application/removed.js.map': 'orphan map',
      'dist/application/removed.d.ts': 'orphan declaration',
      'dist/retired/removed.js': 'retired module',
      'dist/application/notes.txt': 'unmanaged file',
      'dist/worker.mjs': 'embedded private snapshot',
      'dist/custom.js': 'root bundle',
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), content);
    }
    execFileSync(process.execPath, [script], { cwd: root });
    expect((await readdir(join(root, 'dist'))).sort()).toEqual(['application', 'custom.js', 'worker.mjs']);
    expect((await readdir(join(root, 'dist/application'))).sort()).toEqual(['current.d.ts', 'current.js', 'current.js.map', 'notes.txt']);
    for (const [file, content] of Object.entries(files).filter(([file]) => !file.includes('removed.'))) {
      expect(await readFile(join(root, file), 'utf8')).toBe(content);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts a fresh checkout without creating build output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pku-build-'));
  try {
    execFileSync(process.execPath, [script], { cwd: root });
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
