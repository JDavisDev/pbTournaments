'use client';

// Match alerts on this phone: a notification when their match is called,
// free, in place of a text.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InstallSteps } from '@/components/AddToHome';
import { Icon } from '@/components/Icon';
import { Button, Card, ErrorText } from '@/components/ui';
import { isGuest } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { useAction, useSession } from '@/lib/hooks';
import { isIos, isStandalone, useInstallWay } from '@/lib/install';
import { alertsConfigured, alertsSupported, currentAlerts, sendTestAlert, turnOffAlerts, turnOnAlerts } from '@/lib/push';

type State = 'loading' | 'install-first' | 'unsupported' | 'blocked' | 'off' | 'on';

export function MatchAlerts({ next }: { next?: string }) {
  const user = useSession();
  const way = useInstallWay();
  const [state, setState] = useState<State>('loading');
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [tested, setTested] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    let current = true;
    const set = (s: State) => current && setState(s);
    if (isIos() && !isStandalone()) set('install-first');
    else if (!alertsSupported()) set('unsupported');
    else if (Notification.permission === 'denied') set('blocked');
    else
      currentAlerts()
        .then((s) => {
          if (!current) return;
          setSub(s);
          setState(s ? 'on' : 'off');
        })
        .catch(() => set('off'));
    return () => {
      current = false;
    };
  }, []);

  if (!alertsConfigured || state === 'loading' || user === undefined) return null;

  const body = (() => {
    if (!user || isGuest(user)) {
      return (
        <p>
          <Link href={`/profile?mode=login${next ? `&next=${encodeURIComponent(next)}` : ''}`} className="font-medium underline">
            Log in
          </Link>{' '}
          to get them on this phone.
        </p>
      );
    }
    switch (state) {
      case 'install-first':
        return (
          <>
            <p className="font-medium">On iPhone, add {BRAND.name} to your Home Screen first, then turn alerts on from there.</p>
            <InstallSteps way={way ?? 'ios'} alerts={false} />
          </>
        );
      case 'unsupported':
        return <p className="text-muted">This browser can’t show alerts. You’ll get texts instead, if you turned them on.</p>;
      case 'blocked':
        return <p className="text-muted">Notifications are blocked for this site. Allow them in your phone’s settings to get alerts.</p>;
      case 'on':
        return (
          <>
            <p className="font-medium text-live">Alerts are on for this phone.</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => run(async () => setTested(await sendTestAlert()))}>
                Send a test alert
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await turnOffAlerts(sub!);
                    setSub(null);
                    setState('off');
                  })
                }
              >
                Turn off
              </Button>
            </div>
            {tested !== null && (
              <p className="text-sm text-muted">
                {tested ? 'Sent. It should pop up in a few seconds.' : 'Nothing went out: turn alerts off and on again.'}
              </p>
            )}
          </>
        );
      default:
        return (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setSub(await turnOnAlerts());
                setState('on');
              })
            }
          >
            Turn on match alerts
          </Button>
        );
    }
  })();

  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="flex items-center gap-2 text-xl">
        <Icon name="bell" className="h-6 w-6" />
        Match alerts
      </h2>
      <p className="text-sm text-muted">
        A notification on this phone when your match is called to a court, with a tap to report the score. Phones with alerts
        on don’t get those texts.
      </p>
      {body}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
