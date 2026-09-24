// Synthetic public-page structure; no personal information or copied HTML.
export const autumnCalendar = [
  '一、上课',
  '校本部：9 月 7 日',
  '医学部：在校本科生：8 月 31 日',
  '本科新生、研究生：9 月 7 日',
  '深圳研究生院：9 月 7 日',
  '二、中秋节',
  '9 月 25 日，中秋节，放假，全校停课',
  '9 月 26 日-27 日，公休，课程照常进行',
  '三、国庆节',
  '9 月 20 日，公休，课程照常进行',
  '10 月 1 日至 7 日，放假，全校停课',
  '10 月 10 日，公休，课程照常进行',
  '四、校本部运动会：10 月 10 日至 11 日',
  '五、停课复习考试',
  '校本部、医学部：12 月 28 日至 1 月 10 日',
  '深圳研究生院：1 月 11 日至 17 日',
  '六、学生寒假',
  '校本部、医学部：1 月 11 日至 2 月 21 日',
  '深圳研究生院：1 月 18 日至 2 月 21 日',
  '元旦放假安排待公布 2027 年节假日安排后另行通知。',
];
export const springCalendar = [
  '一、上课：2 月 22 日',
  '教职工上班：2 月 17 日',
  '二、劳动节及校庆',
  '5 月 1 日，劳动节，放假，全校停课',
  '5 月 2 日至 7 日，放假调休，全校停课',
  '5 月 4 日，校庆相关单位上班，全校停课',
  '5 月 8 日至 9 日，公休，课程照常进行',
  '三、停课复习考试',
  '校本部、医学部：6 月 14 日至 27 日',
  '深圳研究生院：6 月 28 日至 7 月 4 日',
  '清明节、端午节放假安排另行通知。',
];
export function academicCalendar(autumn = autumnCalendar, spring = springCalendar): string {
  return `<div class="school_calendar"><div class="tit">北京大学\n2026-2027\n学年校历</div><div class="txt">${[
    '第一学期', ...autumn, '第二学期', ...spring, '北京大学2026-2027学年上课时间',
  ].map(line => `<p><strong>${line}</strong></p>`).join('\n')}<table><tr><td><p>第一节08:00—08:50</p></td></tr></table></div></div>`;
}
