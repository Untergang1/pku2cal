import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calendarIdentity } from '../calendar/compare.js';
import { configWithPrivateConfirmations, validateConfig } from '../application/config.js';
import { generateCalendar, type GeneratedCalendar } from '../application/generate.js';
import { assertGenerationAllowed } from '../application/semester.js';
import { readPrivateConfirmations } from './node.js';
import { savePagesState, subscriptionUrl, validatePagesToken } from './pages-state.js';

export interface PagesDecision { changed: boolean; reason: 'missing' | 'changed' | 'unchanged' | 'forced' }

export async function preparePages(options: {
  token: string; baseUrl: string; force: boolean; directory: string;
  generate: () => Promise<GeneratedCalendar>; fetch: typeof fetch; assertAllowed: () => void;
}): Promise<PagesDecision> {
  const url = subscriptionUrl(options.baseUrl, options.token);
  options.assertAllowed();
  const candidate = await options.generate();
  const identity = calendarIdentity(candidate.ics);
  let reason: PagesDecision['reason'] = 'forced';
  if (!options.force) {
    try {
      const response = await options.fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      });
      if (response.status === 404) reason = 'missing';
      else if (response.status === 200) reason = calendarIdentity(await response.text()) === identity ? 'unchanged' : 'changed';
      else throw new Error();
    } catch {
      // Fetch errors may contain the entire private URL or upstream response body.
      throw new Error('pages:comparison_failed');
    }
  }
  if (reason === 'unchanged') return { changed: false, reason };
  options.assertAllowed();
  // This is a dedicated, ignored staging directory, never an existing deployment.
  await rm(options.directory, { recursive: true, force: true });
  await mkdir(options.directory, { recursive: true });
  await savePagesState(resolve(options.directory, options.token, 'calendar.ics'), candidate.ics);
  return { changed: true, reason };
}

export async function main(): Promise<void> {
  try {
    const token = validatePagesToken(process.env.PAGES_CALENDAR_TOKEN ?? '');
    // upload-pages-artifact lists file paths while archiving. Mask before any such output.
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
    const force = process.env.PAGES_FORCE_PUBLISH ?? 'false';
    if (!['true', 'false'].includes(force)) throw new Error();
    const confirmations = await readPrivateConfirmations(process.env.PKU_UNSCHEDULED_COURSES, process.env.PKU_UNSCHEDULED_COURSES_FILE);
    const config = configWithPrivateConfirmations(JSON.parse(await readFile('config/calendar.json', 'utf8')), confirmations);
    const decision = await preparePages({
      token, baseUrl: process.env.PAGES_BASE_URL ?? '', force: force === 'true', directory: resolve('site'),
      generate: () => generateCalendar(config, { username: process.env.PKU_USERNAME ?? '', password: process.env.PKU_PASSWORD ?? '' }, { fetch, now: () => new Date() }),
      fetch, assertAllowed: () => assertGenerationAllowed(validateConfig(config), new Date()),
    });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${decision.changed}\nreason=${decision.reason}\n`);
    console.log(`Pages check: ${decision.reason}`);
  } catch {
    console.error('Pages 检查失败：请检查配置、令牌、校历有效期、上游获取及线上日历响应；本次未上传或部署。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
