'use client';

// Help for players: tournament day, the Home Screen, alerts and accounts.
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { isDemoMode } from '@/lib/config';
import { AlertSteps, AlertTroubles, AndroidInstallSteps, IosInstallSteps } from './HelpSteps';

/** The header's Help button, or a plain link (the footer). */
export function HelpButton({ link = false }: { link?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {link ? (
        <button type="button" className="hover:text-text hover:underline" onClick={() => setOpen(true)}>
          Help
        </button>
      ) : (
        <button
          type="button"
          aria-label="Help"
          title="Help"
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium hover:bg-surface-2"
          onClick={() => setOpen(true)}
        >
          <Icon name="help" className="h-6 w-6" />
          <span className="hidden lg:inline">Help</span>
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Help">
        <HelpContent />
      </Modal>
    </>
  );
}

const sections = [
  ['day', 'Tournament day'],
  ['late', 'Running late or can’t play'],
  ['register', 'Registering'],
  ['rules', 'Division rules'],
  ['home', 'Home Screen'],
  ['alerts', 'Match alerts'],
  ['texts', 'Texts and emails'],
  ['account', 'Your account'],
  ['text-size', 'Bigger text'],
  ['directors', 'Running a tournament'],
  ['questions', 'Questions'],
] as const;
type SectionId = (typeof sections)[number][0];

function Section({ id, children }: { id: SectionId; children: React.ReactNode }) {
  const title = sections.find(([key]) => key === id)![1];
  return (
    <section id={`help-${id}`} className="flex scroll-mt-20 flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-xl">{title}</h3>
      {children}
    </section>
  );
}

/** A list of short questions and answers. */
function Answers({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="flex flex-col gap-2">
      {items.map(([q, a]) => (
        <div key={q}>
          <dt className="font-medium">{q}</dt>
          <dd className="text-muted">{a}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HelpContent() {
  return (
    <div className="flex flex-col gap-5 text-lg">
      <nav aria-label="Help topics" className="flex flex-wrap gap-2">
        {sections.map(([id, title]) => (
          <button
            key={id}
            type="button"
            className="min-h-10 rounded-full bg-surface-2 px-3 text-base font-medium hover:bg-border"
            onClick={() => document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            {title}
          </button>
        ))}
      </nav>
      <Section id="day">
        <Answers
          items={[
            ['Find your matches', 'On the tournament’s page, type your last name under Find your matches, then tap your team.'],
            ['Check in', 'At the desk when you arrive. If there’s a QR code, scan it with your phone’s camera and tap Confirm. Partners each check in.'],
            ['Your court', 'When your match is called you get an alert or a text with the court and your opponent. Your team’s page shows it too.'],
            ['Report your score', 'Right after the match, tap the link in your alert or text and enter the games. A wrong score? Tell the desk; directors can fix it.'],
            ['Watching', 'Anyone can follow along on the tournament’s page, or open More → TV board for every court on a big screen.'],
          ]}
        />
      </Section>

      <Section id="late">
        <Answers
          items={[
            [
              'Late?',
              'Check in as soon as you get there. When your division starts you get a check-in deadline; a team that isn’t checked in by then forfeits its matches. Checking in late brings back the ones nobody has played on from yet.',
            ],
            ['Hurt or can’t play on?', 'Tell the desk. They can put in a substitute or an alternate team, or withdraw your team.'],
            [
              'Withdrawing before the tournament',
              'Open the link in your registration email and tap Withdraw. Any credit follows the tournament’s refund policy, shown before you confirm.',
            ],
          ]}
        />
      </Section>

      <Section id="register">
        <Answers
          items={[
            ['Signing up', 'Tap Register on the tournament’s page and choose your events. With an account, your details are filled in.'],
            [
              'Your partner',
              'Enter your partner’s email. You’re a team once they register with your email as their partner. You can pay their entry too and send them a link to sign up.',
            ],
            ['Full events', 'Join the waitlist; nothing is charged. If a spot opens, you get a text and an email with a link to claim it.'],
            ['Your registration', 'Your confirmation email has a link to see your events. Add the tournament to your calendar from there.'],
          ]}
        />
      </Section>

      <Section id="rules">
        <Answers
          items={[
            ['Ratings', 'Skill divisions go by your DUPR rating, or your own rating where the division allows it. Some divisions let you play up.'],
            ['Ages', 'Counted on the tournament day, or on Dec 31 when the division says so.'],
            ['Mixed doubles', 'One man and one woman.'],
            ['If you don’t fit', 'The director may move your team to another division before it starts. You get an email if they do.'],
          ]}
        />
      </Section>

      <Section id="home">
        <p className="text-muted">{BRAND.name} then opens like an app, full screen. It’s free and takes no space.</p>
        <h4 className="font-semibold">iPhone</h4>
        <IosInstallSteps />
        <h4 className="font-semibold">Android</h4>
        <AndroidInstallSteps />
      </Section>

      <Section id="alerts">
        <p className="text-muted">
          A notification when your match is called to a court, with a tap to report the score. Phones with alerts on don’t get
          those texts. On iPhone, add {BRAND.name} to your Home Screen first.
        </p>
        <AlertSteps />
        <h4 className="mt-2 font-semibold">If it doesn’t work</h4>
        <AlertTroubles />
      </Section>

      <Section id="texts">
        <Answers
          items={[
            [
              'Texts',
              'If you chose “Text me match and court updates” when registering: your court calls, court changes and messages from the desk. Reply STOP to stop them; you can follow your team’s page instead. Message and data rates may apply.',
            ],
            ['Emails', 'Your registration, withdrawals, waitlist spots, and division changes.'],
          ]}
        />
      </Section>

      <Section id="account">
        <ul className="flex list-disc flex-col gap-2 pl-6">
          <li>Sign up once and registering for any tournament only asks which events. You must be 18 or older.</li>
          <li>Forgot your password? On the log-in page, tap Email me a sign-in link.</li>
          <li>
            Signing up may ask you to confirm your email. The link opens in your browser: confirm there, then log in again in the
            Home Screen app.
          </li>
          <li>Edit your details any time from the person icon at the top right.</li>
          <li>
            To delete your account, go to the bottom of your profile. Tournaments keep their payment records and results, without
            your name.
          </li>
          {isDemoMode && <li>On this demo site, Sign in uses a shared guest account to look around. Sign up for your own to test alerts.</li>}
        </ul>
      </Section>

      <Section id="text-size">
        <p className="text-muted">
          Tap <span className="font-semibold text-text">Tt</span> at the top to switch between normal, large and larger text. Your
          phone remembers it.
        </p>
      </Section>

      <Section id="directors">
        <Answers
          items={[
            ['Start one', 'Tap Create Tournament on the home page. You own every tournament you create.'],
            ['Your tournaments', 'Your profile lists them under Tournaments you run.'],
            ['Help running it', 'Add managers under Managers in Setup (Settings, once registration opens). They use their own accounts.'],
            [
              'On the day',
              'Turn on self check-in on the Check-in page for a desk QR code. The Players page fixes details, moves teams and flags anyone outside the division rules. Each division can print scoresheets and draws as a backup.',
            ],
          ]}
        />
      </Section>

      <Section id="questions">
        <p className="text-muted">
          About a tournament: tap Contact on its page to email the director. About {BRAND.name}:{' '}
          <a href={`mailto:${BRAND.contactEmail}`} className="font-medium text-text underline">
            {BRAND.contactEmail}
          </a>
          .
        </p>
      </Section>
    </div>
  );
}
