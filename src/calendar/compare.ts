import ICAL from 'ical.js';

/** Canonicalize parameters as well as properties; preserve ordered property values. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function canonical(component: ICAL.Component): unknown {
  const properties = component.getAllProperties()
    .filter(property => !(component.name === 'vevent' && property.name === 'dtstamp'))
    .map(property => JSON.stringify(stable(property.toJSON()))).sort();
  const children = component.getAllSubcomponents().map(child => JSON.stringify(canonical(child))).sort();
  return [component.name, properties, children];
}

/** Compare complete calendars, ignoring only VEVENT generation timestamps. */
export function calendarIdentity(ics: string): string {
  try {
    const normalized = ics.replace(/\r\n/g, '\n').trim();
    if (!normalized.startsWith('BEGIN:VCALENDAR\n') || !normalized.endsWith('\nEND:VCALENDAR')) throw new Error();
    const calendar = new ICAL.Component(ICAL.parse(ics));
    if (calendar.name !== 'vcalendar' || calendar.getFirstPropertyValue('version') !== '2.0' || !calendar.getFirstPropertyValue('prodid')) throw new Error();
    const seen = new Set<string>();
    for (const event of calendar.getAllSubcomponents('vevent')) {
      for (const name of ['uid', 'dtstamp', 'dtstart', 'dtend', 'summary']) {
        if (event.getAllProperties(name).length !== 1) throw new Error();
      }
      const uid = event.getFirstPropertyValue('uid');
      if (typeof uid !== 'string' || !uid || seen.has(uid) || !event.getFirstPropertyValue('summary')) throw new Error();
      seen.add(uid);
      for (const name of ['dtstamp', 'dtstart', 'dtend']) {
        const property = event.getFirstProperty(name)!;
        const value = property.getFirstValue();
        // ical.js normalizes out-of-range dates (e.g. February 31); reject repairs.
        if (!(value instanceof ICAL.Time) || value.isDate || !Number.isFinite(value.toJSDate().getTime())
          || property.toJSON()[3] !== value.toString()) throw new Error();
      }
      const start = event.getFirstPropertyValue('dtstart') as ICAL.Time;
      const end = event.getFirstPropertyValue('dtend') as ICAL.Time;
      if (start.compare(end) >= 0) throw new Error();
    }
    return JSON.stringify(canonical(calendar));
  } catch {
    throw new Error('pages:invalid_calendar');
  }
}
