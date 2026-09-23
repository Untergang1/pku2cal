import { authenticate, type Credentials } from './auth.js';
import type { Fetch } from './http.js';

export const RESULTS = 'https://elective.pku.edu.cn/elective2008/edu/pku/stu/elective/controller/electiveWork/showResults.do';

export async function fetchTimetable(credentials: Credentials, fetcher: Fetch): Promise<string> {
  const session = await authenticate(credentials, fetcher);
  const page = await session.request(RESULTS, {
    headers: { referer: 'https://elective.pku.edu.cn/elective2008/edu/pku/stu/elective/controller/help/HelpController.jpf' },
  }, true);
  return page.body;
}
