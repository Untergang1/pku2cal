import type { CalendarEvent } from '../schedule/expand.js';

export class CalendarError extends Error {
  constructor() { super('calendar:invalid'); this.name = 'CalendarError'; }
}

export function escapeText(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new CalendarError();
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export function foldLine(value: string): string {
  const encoder = new TextEncoder();
  let line = '';
  let bytes = 0;
  let output = '';
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) { output += `${line}\r\n`; line = ' '; bytes = 1; }
    line += char;
    bytes += size;
  }
  return output + line;
}

function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CalendarError();
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function serializeCalendar(events: CalendarEvent[], generatedAt: Date): string {
  if (!Number.isFinite(generatedAt.getTime())) throw new CalendarError();
  const stamp = timestamp(generatedAt.toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//pku2cal//PKU Timetable//ZH', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:Asia/Shanghai'];
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid))) {
    if (!/^[a-f0-9]{64}@pku2cal$/.test(event.uid) || !event.summary.trim() || seen.has(event.uid) || Date.parse(event.start) >= Date.parse(event.end)) throw new CalendarError();
    seen.add(event.uid);
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${timestamp(event.start)}`, `DTEND:${timestamp(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`, `LOCATION:${escapeText(event.location)}`, `DESCRIPTION:${escapeText(event.description)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
