import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/LegalPage';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = { title: 'Terms of Service' };

// A draft for legal review. Keep in step with the Privacy Policy and the app:
// what it collects, who runs each tournament, payments, texts and DUPR.
export default function TermsPage() {
  const name = BRAND.name;
  const owner = BRAND.owner;
  return (
    <LegalPage title="Terms of Service">
      <p>
        These Terms of Service (“Terms”) are an agreement between you and {owner} (“{name}”, “we”, “us”). They cover{' '}
        {BRAND.domain}, the text messages and emails we send, and everything else we provide to run pickleball tournaments
        (together, the “Service”). By creating an account, registering for a tournament, or otherwise using the Service, you
        agree to these Terms and to our <Link href="/privacy">Privacy Policy</Link>. If you don’t agree, don’t use the
        Service.
      </p>
      <p>
        If you register someone else, such as your child or a partner, you confirm you’re allowed to and you agree to these
        Terms for them. A parent or guardian must register anyone under 18.
      </p>

      <h2>1. Who runs a tournament</h2>
      <p>
        {name} is software that tournament directors and their organizations (“Directors”) use to run their events:
        registration, payments, brackets, court assignments, texts and results. Each tournament is organized by its
        Director, not by {name}. The Director is responsible for the event itself, including its venue, schedule, rules,
        divisions and eligibility, prices, refunds, waivers, safety and conduct, and for decisions made during play.
        Questions about a tournament should go to its Director.
      </p>

      <h2>2. Accounts</h2>
      <ul>
        <li>Players can register and follow a tournament without an account. Directors and their staff need one.</li>
        <li>Give accurate information, keep your password private, and tell us if you think your account has been misused. You’re responsible for what happens under your account.</li>
        <li>Demo and practice tournaments are for trying the Service. They may be shared with other visitors and are deleted after about two weeks.</li>
      </ul>

      <h2>3. Registration and payments</h2>
      <ul>
        <li>Directors set each tournament’s prices, which may include a registration fee, event fees, and prices that change on set dates. The price shown when you register is the price you pay.</li>
        <li>Payments are processed by our payment processor, Stripe, under its own terms. We don’t store your full card number. Depending on the tournament, payment may be collected by {owner} on the Director’s behalf or paid to the Director’s own payment account.</li>
        <li>A spot is held while you pay, for a limited time. Divisions that are full take a waitlist; you aren’t charged unless a spot is offered and you accept it.</li>
        <li>You can pay a partner’s entry. That payment covers their spot; they still register to add their details and agree to any waiver.</li>
        <li>Refunds follow the tournament’s refund policy, which its Director sets and decides. Withdrawing may credit you, as the tournament’s page and registration explain. {name} isn’t responsible for a Director’s refund decisions.</li>
        <li>Discount codes are offered by Directors, on the terms they set.</li>
      </ul>

      <h2>4. Waivers and the risks of play</h2>
      <p>
        Pickleball is a physical activity with a risk of injury. Waivers you accept when registering are between you and
        the tournament’s Director or organization; {name} is not a party to them. You take part in tournaments at your own
        risk, and {name} is not responsible for injuries, losses or anything else that happens at an event.
      </p>

      <h2>5. Ratings, eligibility and results</h2>
      <ul>
        <li>Enter your own DUPR ID and ratings accurately. Directors may check them, move you to another division, or remove an entry that doesn’t meet a division’s rules.</li>
        <li>Names, team names, divisions, schedules, scores, standings and results are shown publicly on the tournament’s pages and screens.</li>
        <li>When a division is DUPR-rated, its results, with players’ names and DUPR IDs, are sent to DUPR.</li>
      </ul>

      <h2>6. Text messages</h2>
      <p>
        If you give a mobile number and agree to texts, you’ll get messages about the tournaments you’re in: when your
        match is called and where, schedule changes, waitlist offers, and messages from the Director. How many depends on
        the tournament; expect several on a tournament day. Message and data rates may apply. Reply STOP to stop texts and
        HELP for help, or contact us. Carriers aren’t liable for delayed or undelivered messages. You can follow your team’s
        page instead of texts.
      </p>

      <h2>7. Directors</h2>
      <p>If you run tournaments on {name}, you also agree that:</p>
      <ul>
        <li>You’re authorized to run the event and to accept these Terms for your organization.</li>
        <li>You’ll describe your event, prices, refund policy and waiver accurately, and honor them.</li>
        <li>You’ll use players’ information only to run your events and contact players about them, as our Privacy Policy describes and the law requires, and you won’t use the Service to send marketing or unrelated messages.</li>
        <li>You’ll pay the platform fees shown in the Service when they’re due, such as a setup fee per tournament, a fee per player, and texting per player. We may change fees for future tournaments with notice.</li>
        <li>You’re responsible for the staff you add and what they do.</li>
      </ul>

      <h2>8. Tournament listings</h2>
      <p>
        Anyone signed in can list a tournament that takes sign-ups on another site. We don’t check listings, and the other
        site’s own terms apply to signing up there. We may edit or remove any listing.
      </p>

      <h2>9. Acceptable use</h2>
      <p>Don’t use the Service to:</p>
      <ul>
        <li>break the law or anyone’s rights, or harass, threaten or impersonate anyone;</li>
        <li>enter false information, or register people without their permission;</li>
        <li>send spam, or collect other people’s information for purposes they didn’t agree to;</li>
        <li>interfere with the Service, get around its security, or access it with bots or scrapers except as we allow.</li>
      </ul>

      <h2>10. Your content</h2>
      <p>
        You keep ownership of what you add, such as tournament details, images, team names and messages. You let us host,
        copy, display and process it as needed to run the Service, including showing it on public tournament pages.
      </p>

      <h2>11. Our property</h2>
      <p>
        The {name} name, logo and software belong to {owner}. These Terms don’t give you any right to them beyond using the
        Service as intended.
      </p>

      <h2>12. Changes and availability</h2>
      <p>
        We may change, suspend or stop any part of the Service. We work to keep it running on tournament days, but we don’t
        promise it will always be available or error-free. Court assignments, wait times and schedules are estimates; the
        Director has the final say.
      </p>

      <h2>13. Disclaimers</h2>
      <p>
        The Service is provided “as is” and “as available”. To the fullest extent the law allows, we disclaim all warranties,
        express or implied, including merchantability, fitness for a particular purpose and non-infringement.
      </p>

      <h2>14. Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, {owner} and its owners and staff won’t be liable for indirect, incidental,
        special, consequential or punitive damages, or for lost profits, data or goodwill. Our total liability for any claim
        about the Service is limited to the greater of what you paid {name} itself (not tournament entry fees) in the 12
        months before the claim, or $100.
      </p>

      <h2>15. Indemnity</h2>
      <p>
        You’ll defend and hold harmless {owner} from claims arising from your use of the Service, your content, your breach
        of these Terms, or, for Directors, the events you run.
      </p>

      <h2>16. Ending your use</h2>
      <p>
        You can stop using the Service at any time. We may suspend or end your access if you break these Terms or misuse the
        Service. Sections that by their nature should continue, such as payments owed, disclaimers and limits of liability,
        continue after that.
      </p>

      <h2>17. Governing law</h2>
      <p>
        These Terms are governed by the laws of the state in which {owner} is organized, without regard to its conflict-of-law
        rules, and any dispute will be resolved in the state or federal courts located there.
      </p>

      <h2>18. Changes to these Terms</h2>
      <p>
        We may update these Terms. We’ll post the new version here with its effective date, and tell account holders of
        significant changes. Using the Service after that means you accept them.
      </p>

      <h2>19. Contact</h2>
      <p>
        {owner} · <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>
      </p>
    </LegalPage>
  );
}
