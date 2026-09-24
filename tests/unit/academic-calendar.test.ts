import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_URL, fetchAcademicCalendar, parseAcademicCalendar } from '../../src/pku/academic-calendar.js';
import { importCalendar } from '../../src/application/calendar-pull.js';
import { academicCalendar, autumnCalendar } from '../fixtures/academic-calendar.js';

const html = academicCalendar();
const now = new Date('2026-09-24T00:00:00Z');
const autumn = () => parseAcademicCalendar(html, '2026-2027-1')[0]!;

describe('public academic calendar parsing', () => {
  it('separates campuses and terms, normalizes dates and excludes administrative events', () => {
    const [first, second] = parseAcademicCalendar(html);
    expect(first).toEqual({ semester: '2026-2027-1', firstMonday: '2026-09-07', teachingWeeks: 16, validThrough: '2027-01-10',
      holidays: ['2026-09-25', ...Array.from({ length: 7 }, (_, i) => `2026-10-0${i + 1}`)], makeups: {},
      notices: ['元旦放假安排待公布2027年节假日安排后另行通知。'] });
    expect(second).toEqual({ semester: '2026-2027-2', firstMonday: '2027-02-22', teachingWeeks: 16, validThrough: '2027-06-27',
      holidays: Array.from({ length: 7 }, (_, i) => `2027-05-0${i + 1}`), makeups: {}, notices: ['清明节、端午节放假安排另行通知。'] });
  });
  it('handles inline markup, nonbreaking spaces and line breaks', () => {
    const altered = html.replace('校本部：9 月 7 日', '校本部：9&nbsp;月<span>7</span>日<br>')
      .replace('第一学期', '<span>第一</span>学期');
    expect(parseAcademicCalendar(altered)).toEqual(parseAcademicCalendar(html));
  });
  it('expands cross-month and cross-year holidays and maps explicit makeup dates', () => {
    const page = academicCalendar([...autumnCalendar,
      '七、临时安排', '9月30日至10月2日，全校停课', '2026年12月31日至2027年1月2日，全校停课',
      '10月11日，补上10月1日的课。',
    ]);
    const parsed = parseAcademicCalendar(page, '2026-2027-1')[0]!;
    expect(parsed.holidays).toEqual([...new Set([...autumn().holidays, '2026-09-30', '2026-12-31', '2027-01-01', '2027-01-02'])].sort());
    expect(parsed.makeups).toEqual({ '2026-10-11': '2026-10-01' });
  });
  it.each([
    ['校本部：9 月 7 日', '校本部：9 月 8 日'],
    ['12 月 28 日至 1 月 10 日', '12 月 29 日至 1 月 10 日'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月31日，全校停课'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，部分课程停课'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，放假'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，不上课'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，暂停教学'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，暂停上课'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，补周一的课'],
    ['9 月 25 日，中秋节，放假，全校停课', '9月25日，全校停课，补课安排另行通知'],
    ['校本部：9 月 7 日', '校本部：9 月 7 日</strong></p><p>校本部：9 月 7 日'],
    ['校本部：9 月 7 日', ''],
    ['2026-2027', '2026-2028'],
    ['class="txt"', 'class="changed"'],
  ])('rejects ambiguous or malformed input: %s → %s', (from, to) => {
    expect(() => parseAcademicCalendar(html.replace(from, to), '2026-2027-1')).toThrow('无法明确解析');
  });
  it('rejects contradictory policies and ambiguous makeup destinations', () => {
    for (const extra of [
      ['9月25日，公休，课程照常进行'],
      ['10月11日补10月1日课', '10月11日补10月2日课'],
    ]) expect(() => parseAcademicCalendar(academicCalendar([...autumnCalendar, '七、临时安排', ...extra]), '2026-2027-1')).toThrow();
  });
  it('does not parse unrelated term policies but rejects unavailable academic years', () => {
    expect(parseAcademicCalendar(academicCalendar(autumnCalendar, ['无法解析']), '2026-2027-1')[0]).toEqual(autumn());
    expect(() => parseAcademicCalendar(html, '2027-2028-1')).toThrow('未收录');
  });
  it('does not silently discard policies moved out of paragraphs or into tables', () => {
    for (const replacement of ['<div>9月25日，全校停课</div>', '<table><tr><td><p>9月25日，全校停课</p></td></tr></table>']) {
      expect(() => parseAcademicCalendar(html.replace('<p><strong>9 月 25 日，中秋节，放假，全校停课</strong></p>', replacement), '2026-2027-1')).toThrow('无法明确解析');
    }
  });
  it('retains a deferred policy heading in the warning and excludes campus-specific notices', () => {
    const parsed = parseAcademicCalendar(academicCalendar([...autumnCalendar,
      '七、补课安排', '另行通知', '八、其他通知', '医学部：端午节放假另行通知',
    ]), '2026-2027-1')[0]!;
    expect(parsed.notices).toEqual([...autumn().notices, '补课安排：另行通知']);
  });
});

describe('public retrieval', () => {
  it('uses a timed credential-free request and permits same-origin HTTPS redirects', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/calendar.html' } }))
      .mockResolvedValueOnce(new Response(html));
    expect(await fetchAcademicCalendar(fetcher)).toBe(html);
    expect(fetcher.mock.calls[0]![0]).toBe(CALENDAR_URL);
    expect(fetcher.mock.calls[1]![0]).toBe('https://www.pku.edu.cn/calendar.html');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(fetcher.mock.calls[0]![1].headers).not.toHaveProperty('cookie');
  });
  it.each(['http://www.pku.edu.cn/calendar', 'https://other.test/calendar', 'https://user:pass@www.pku.edu.cn/calendar'])('refuses redirect to %s', async location => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(fetchAcademicCalendar(fetcher)).rejects.toThrow('无法获取');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds redirects and redacts HTTP and network failures', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: CALENDAR_URL } }));
    await expect(fetchAcademicCalendar(redirect)).rejects.toThrow('无法获取');
    expect(redirect).toHaveBeenCalledTimes(6);
    for (const fetcher of [vi.fn().mockResolvedValue(new Response('error', { status: 503 })), vi.fn().mockRejectedValue(new Error('private details'))]) {
      await expect(fetchAcademicCalendar(fetcher)).rejects.toThrow('未使用旧预设');
    }
  });
});

describe('selection and configuration assembly', () => {
  const fetcher = async () => new Response(html);
  it('preserves user choices, replaces dates and binds an explicitly selected new term', async () => {
    const initial = await importCalendar({ fetch: fetcher, now });
    const previous = { ...initial.config, namespace: 'my-calendar', timetable: 'pku-main' as const,
      holidays: ['2026-09-08'], makeups: { '2026-09-09': '2026-09-07' } };
    const next = await importCalendar({ fetch: fetcher, now, previous, semester: '2026-2027-2' });
    expect(next.config).toMatchObject({ namespace: 'my-calendar', timetable: 'pku-main', makeups: {},
      semesterBinding: { confirmedSemester: '2026-2027-2', validFrom: '2027-02-22', validThrough: '2027-06-27' } });
    expect(next.config.holidays).not.toContain('2026-09-08');
    expect(next.changes.join('\n')).toContain('semester:');
    expect(next.changes.join('\n')).not.toContain('namespace:');
    // Existing target semester takes precedence over today's date.
    expect((await importCalendar({ fetch: fetcher, now, previous: next.config })).config).toEqual(next.config);
    expect((await importCalendar({ fetch: fetcher, now, previous: next.config })).changes).toEqual([]);
  });
  it.each([
    ['2026-09-06T15:59:59.999Z', false], ['2026-09-06T16:00:00Z', true],
    ['2027-01-10T15:59:59.999Z', true], ['2027-01-10T16:00:00Z', false],
  ])('selects current term using inclusive Shanghai dates at %s', async (date, matches) => {
    const result = importCalendar({ fetch: fetcher, now: new Date(date) });
    if (matches) expect((await result).config.semester).toBe('2026-2027-1');
    else await expect(result).rejects.toThrow('--semester');
  });
  it('rejects invalid clocks and unsupported terms before network access', async () => {
    const fetch = vi.fn();
    await expect(importCalendar({ fetch, now: new Date('invalid') })).rejects.toThrow('日期无效');
    await expect(importCalendar({ fetch, now, semester: '2026-2027-3' })).rejects.toThrow('春秋学期');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('validates makeup conflicts at the configuration boundary', async () => {
    for (const rules of [
      ['9月25日补10月1日课'], // target is a holiday
      ['10月11日补10月1日课', '10月12日补10月1日课'], // same source twice
      ['10月11日补10月1日课', '10月12日补10月11日课'], // chained moves
    ]) await expect(importCalendar({ now, semester: '2026-2027-1', fetch: async () => new Response(academicCalendar([...autumnCalendar, '七、补课安排', ...rules])) })).rejects.toThrow('configuration:invalid');
  });
});
