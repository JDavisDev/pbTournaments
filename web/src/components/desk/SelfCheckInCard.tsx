'use client';

// Turns on the check-in link for the door: a tablet at the entrance, or a QR
// code players scan with their own phones.
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { getSelfCheckin, setSelfCheckin } from '@/lib/api';
import { useAction, useLoad } from '@/lib/hooks';
import { Button, Card, ErrorText } from '../ui';

export function SelfCheckInCard({ tournamentId }: { tournamentId: string }) {
  const code = useLoad(() => getSelfCheckin(tournamentId), [tournamentId]);
  const { busy, error, run } = useAction();
  const [qr, setQr] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!code.data) return;
    const link = `${window.location.origin}/k/${code.data}`;
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: '#000000', light: '#ffffff' } }).then((image) => {
      if (!cancelled) {
        setUrl(link);
        setQr(image);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code.data]);

  if (code.data === undefined) return null;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl">Self check-in</h2>
          <p className="text-sm text-muted">
            {code.data
              ? 'On. Anyone with this link can check players in, so turn it off when check-in is over.'
              : 'Let players check themselves in on a tablet at the door, or by scanning a QR code.'}
          </p>
        </div>
        <Button
          size="sm"
          variant={code.data ? 'ghost' : 'primary'}
          disabled={busy}
          onClick={() => run(() => setSelfCheckin(tournamentId, !code.data), code.reload)}
        >
          {code.data ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      {code.data && url && (
        <div className="flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr && <img src={qr} alt="QR code for self check-in" className="h-40 w-40 rounded-lg bg-white p-2" />}
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm break-all">{url}</p>
            <div className="flex flex-wrap gap-2">
              <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center rounded-full border border-border px-4 text-sm font-medium hover:border-text">
                Open on this device
              </a>
              {qr && (
                <a href={qr} download="self-check-in.png" className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium underline">
                  Download QR code
                </a>
              )}
            </div>
          </div>
        </div>
      )}
      <ErrorText>{code.error ?? error}</ErrorText>
    </Card>
  );
}
