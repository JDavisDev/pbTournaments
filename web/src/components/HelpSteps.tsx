// Steps players follow, shared by Add to Home, Match alerts and Help so they
// always say the same thing.
import { Icon } from '@/components/Icon';
import { BRAND } from '@/lib/brand';

const list = 'flex list-decimal flex-col gap-2 pl-6';

export function IosInstallSteps() {
  return (
    <ol className={list}>
      <li>
        In Safari or Chrome, tap the <b>Share</b> button <Icon name="share" className="inline h-5 w-5 align-text-bottom" /> (at the
        bottom in Safari, at the top in Chrome).
      </li>
      <li>
        Scroll down and tap <b>Add to Home Screen</b>.
      </li>
      <li>
        Tap <b>Add</b>.
      </li>
    </ol>
  );
}

export function AndroidInstallSteps() {
  return (
    <ol className={list}>
      <li>
        Tap <b>Add to Home</b> at the top of {BRAND.name}, or open your browser’s menu (<b>⋮</b>, top right).
      </li>
      <li>
        Tap <b>Install</b>, <b>Add to Home screen</b> or <b>Install app</b>.
      </li>
    </ol>
  );
}

export function AlertSteps() {
  return (
    <ol className={list}>
      <li>
        Open {BRAND.name} from its <b>Home Screen icon</b>, not your browser.
      </li>
      <li>
        <b>Log in</b> with your account. On iPhone the Home Screen app has its own login, so you log in once more there.
      </li>
      <li>
        Tap the <b>person icon</b> <Icon name="person" className="inline h-5 w-5 align-text-bottom" /> at the top right to open your
        profile.
      </li>
      <li>
        Under <b>Match alerts</b>, tap <b>Turn on match alerts</b>, then <b>Allow</b>.
      </li>
      <li>
        Tap <b>Send a test alert</b>. It should pop up within a few seconds.
      </li>
    </ol>
  );
}

const troubles: [string, string][] = [
  ['“Add Courtside to your Home Screen first”', 'You’re in the browser. Open Courtside from its Home Screen icon.'],
  ['“This browser can’t show alerts”', 'iPhones need iOS 16.4 or later (Settings → General → About). You’ll get texts instead, if you turned them on.'],
  ['“Notifications are blocked”', 'Go to Settings → Notifications → Courtside and turn on Allow Notifications.'],
  ['“Nothing went out”', 'Tap Turn off, then Turn on match alerts again.'],
  ['No Match alerts on your profile', 'Log in with your own account. A shared guest account can’t get alerts.'],
];

export function AlertTroubles() {
  return (
    <dl className="flex flex-col gap-2">
      {troubles.map(([what, fix]) => (
        <div key={what}>
          <dt className="font-medium">{what}</dt>
          <dd className="text-muted">{fix}</dd>
        </div>
      ))}
    </dl>
  );
}
