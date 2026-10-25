'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { Tournament, TournamentEvent } from '@/lib/types';
import { Button, Modal, Select } from './ui';

interface ShareLink {
  key: string;
  label: string;
  hint: string;
  url: string;
}

/** Links to share: the tournament page, sign-up (whole tournament or one division), the TV board, the stream. */
export function shareLinks(t: Tournament, events: TournamentEvent[], origin: string): ShareLink[] {
  const base = `${origin}/t/${t.id}`;
  const links: ShareLink[] = [
    { key: 'page', label: 'Tournament page', hint: 'Schedules, courts, standings and brackets', url: base },
  ];
  if (t.status === 'registration') {
    links.push({ key: 'register', label: 'Sign-up link', hint: 'Every open division', url: `${base}/register` });
    for (const e of events) {
      links.push({ key: `register-${e.id}`, label: `Sign up: ${e.name}`, hint: 'Opens with this division picked', url: `${base}/register?event=${e.id}` });
    }
  }
  links.push({ key: 'tv', label: 'TV board', hint: 'For the screens at the venue', url: `${origin}/tv/${t.id}` });
  if (t.stream_url) links.push({ key: 'stream', label: 'Live stream', hint: 'YouTube', url: t.stream_url });
  return links;
}

export function ShareDialog({
  open,
  onClose,
  tournament,
  events,
}: {
  open: boolean;
  onClose: () => void;
  tournament: Tournament;
  events: TournamentEvent[];
}) {
  // Links only render once the dialog opens, in the browser.
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));
  const links = origin ? shareLinks(tournament, events, origin) : [];
  const [selected, setSelected] = useState('page');
  const link = links.find((l) => l.key === selected) ?? links[0];
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    QRCode.toDataURL(link.url, { margin: 1, width: 480, color: { dark: '#000000', light: '#ffffff' } }).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [link?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copy(l: ShareLink) {
    try {
      await navigator.clipboard.writeText(l.url);
      setCopied(l.key);
      setTimeout(() => setCopied((k) => (k === l.key ? null : k)), 1500);
    } catch {
      window.prompt('Copy this link', l.url);
    }
  }

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  return (
    <Modal open={open} onClose={onClose} title="Share">
      {link && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface-2 p-4">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt={`QR code for ${link.label}`} className="h-52 w-52 rounded-lg bg-white p-2" />
            ) : (
              <div className="h-52 w-52 rounded-lg bg-white" />
            )}
            <Select className="w-full" value={link.key} onChange={(e) => setSelected(e.target.value)} aria-label="Link to show">
              {links.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Select>
            <p className="text-center text-xs text-muted">Print it or put it on the TV so players can scan it.</p>
            {qr && (
              <a href={qr} download={`${tournament.name} - ${link.label}.png`} className="text-sm font-medium underline">
                Download QR code
              </a>
            )}
          </div>

          <ul className="flex flex-col divide-y divide-border">
            {links.map((l) => (
              <li key={l.key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{l.label}</p>
                  <p className="truncate text-xs text-muted">{l.url.replace(/^https?:\/\//, '')}</p>
                </div>
                <Button size="sm" onClick={() => copy(l)}>
                  {copied === l.key ? 'Copied' : 'Copy'}
                </Button>
              </li>
            ))}
          </ul>

          {canShare && (
            <Button
              variant="primary"
              onClick={() => navigator.share({ title: tournament.name, text: link.hint, url: link.url }).catch(() => {})}
            >
              Share {link.label.toLowerCase()}…
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
