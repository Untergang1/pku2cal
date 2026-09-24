import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { savePrivateFile } from '../../src/entrypoints/private-files.js';

it('replaces private files atomically with restrictive permissions and no temporary residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pku-private-'));
  try {
    const directory = join(root, 'state');
    const path = join(directory, 'token.json');
    await savePrivateFile(path, 'first');
    await savePrivateFile(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(['token.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('cleans temporary private contents when replacement fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pku-private-'));
  try {
    const path = join(root, 'occupied');
    await mkdir(path);
    await expect(savePrivateFile(path, 'private content')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['occupied']);
    expect((await stat(path)).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
