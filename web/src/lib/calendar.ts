// Add-to-calendar for players: an all-day event over the days they play, as a
// Google Calendar link or an .ics file (Apple Calendar, Outlook).

export interface CalendarEvent {
  title: string;
  /** First and last day, as YYYY-MM-DD. */
  firstDay: string;
  lastDay: string;
  location: string;
  details: string;
  url: string;
  /** Stable, so adding it again updates the same calendar entry. */
  uid: string;
}

const compact = (day: string) => day.replaceAll('-', '');

/** All-day events end on the day after. */
function dayAfter(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function googleCalendarUrl(e: CalendarEvent) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${compact(e.firstDay)}/${compact(dayAfter(e.lastDay))}`,
    details: `${e.details}\n\n${e.url}`,
    location: e.location,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const escape = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes continue on the next line, starting with a space. */
function fold(line: string) {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 74) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  return [...out, current].join('\r\n');
}

export function icsFile(e: CalendarEvent, now: Date) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Courtside//Tournaments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compact(e.firstDay)}`,
    `DTEND;VALUE=DATE:${compact(dayAfter(e.lastDay))}`,
    `SUMMARY:${escape(e.title)}`,
    `LOCATION:${escape(e.location)}`,
    `DESCRIPTION:${escape(`${e.details}\n\n${e.url}`)}`,
    `URL:${e.url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n');
}
