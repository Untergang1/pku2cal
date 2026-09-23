import { mkdir, writeFile } from 'node:fs/promises';
import { fetchTimetable } from '../dist/pku/elective.js';

try {
  const html = await fetchTimetable({
    username: process.env.PKU_USERNAME ?? '', password: process.env.PKU_PASSWORD ?? '',
  }, fetch);
  await mkdir('data', { recursive: true, mode: 0o700 });
  await writeFile('data/upstream.html', html, { mode: 0o600 });
  console.log('probe:success (private HTML saved under data/)');
} catch (error) {
  console.error(`probe:${error?.name === 'PkuError' ? error.code : 'failed'}`);
  process.exitCode = 1;
}
