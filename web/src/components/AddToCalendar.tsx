'use client';

// After registering: put the tournament on the player's calendar.
import { useEffect, useState } from 'react';
import { divisionDay } from '@/components/DivisionStatus';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui';
import { getEvents, getTournament } from '@/lib/api';
import { type CalendarEvent, googleCalendarUrl, icsFile } from '@/lib/calendar';
import { formatTime, venueLine } from '@/lib/format';

export function AddToCalendar({ tournamentId, eventIds, uid }: { tournamentId: string; eventIds: string[]; uid: string }) {
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const key = eventIds.join(',');

  useEffect(() => {
    let current = true;
    Promise.all([getTournament(tournamentId), getEvents(tournamentId)])
      .then(([t, events]) => {
        if (!current) return;
        const mine = events.filter((e) => key.split(',').includes(e.id));
        const days = (mine.length ? mine.map((e) => divisionDay(e, t)) : [t.starts_on]).sort();
        // Start times only once the director has published them; they can still change.
        const lines = mine.map((e) => {
          const time = t.times_published_at && e.not_before ? ` (starts ${formatTime(e.not_before, t.time_zone)})` : '';
          return `${e.name}${time}`;
        });
        setEvent({
          title: t.name,
          firstDay: days[0],
          lastDay: days[days.length - 1],
          location: venueLine(t),
          details: [lines.length ? `Your events: ${lines.join(', ')}.` : '', 'Times can change; check the tournament page for the latest.']
            .filter(Boolean)
            .join('\n'),
          url: `${window.location.origin}/t/${tournamentId}`,
          uid: `${uid}@courtside`,
        });
      })
      .catch(() => current && setEvent(null));
    return () => {
      current = false;
    };
  }, [tournamentId, key, uid]);

  if (!event) return null;

  const download = () => {
    const blob = new Blob([icsFile(event, new Date())], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${event.title.replace(/[^\w -]+/g, '').trim() || 'tournament'}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="primary" onClick={download}>
        <Icon name="calendar" className="h-5 w-5" />
        Add to calendar
      </Button>
      <a
        href={googleCalendarUrl(event)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-12 items-center justify-center rounded-full px-4 font-medium underline underline-offset-4"
      >
        Google Calendar
      </a>
    </div>
  );
}
