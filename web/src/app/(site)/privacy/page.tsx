import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/LegalPage';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = { title: 'Privacy Policy' };

// A draft for legal review. Keep it in step with what the app collects
// (registration form, accounts, device storage) and who it shares with.
export default function PrivacyPage() {
  const name = BRAND.name;
  const owner = BRAND.owner;
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This policy explains what {owner} (“{name}”, “we”) collects when you use {BRAND.domain}, our texts and emails (the
        “Service”), how we use it, and the choices you have. It’s part of our <Link href="/terms">Terms of Service</Link>.
        We don’t sell your information, and we don’t show ads.
      </p>

      <h2>1. What we collect</h2>
      <p>
        <b>When you register for a tournament:</b>
      </p>
      <ul>
        <li>your name, email and mobile number, and whether you agree to texts;</li>
        <li>what a division needs to check eligibility, such as gender, birth date, DUPR ID and ratings, or a self-rating;</li>
        <li>your partner’s name and email, and your answers to the Director’s questions (for example, T-shirt size);</li>
        <li>that you accepted the waiver and these terms, and when;</li>
        <li>payment status, amounts, discounts, credits and refunds. Card details go to Stripe; we never see or store your full card number.</li>
      </ul>
      <p>
        <b>On tournament day:</b> check-in, your matches, scores, standings and results.
      </p>
      <p>
        <b>When someone else enters you:</b> a partner may give us your name and email so we can pair you, and a Director may
        add or correct your details.
      </p>
      <p>
        <b>Directors and staff:</b> your account email and sign-in details (passwords are stored hashed by our authentication
        provider), your organization, the tournaments you run, and the people you invite.
      </p>
      <p>
        <b>Listings:</b> what you post about a tournament.
      </p>
      <p>
        <b>Automatically:</b> our hosting providers keep standard logs (such as IP address, browser and pages requested) to
        run and protect the Service. Your browser stores a few settings on your device, such as your sign-in session, text
        size, the team you follow and sections you’ve opened. We don’t use advertising cookies or third-party trackers.
      </p>

      <h2>2. How we use it</h2>
      <ul>
        <li>to run tournaments: registration, eligibility, partners, waitlists, schedules, court calls, scores and results;</li>
        <li>to take payments, apply discounts, and handle credits and refunds;</li>
        <li>to send texts and emails about the tournaments you’re in, and messages from their Directors;</li>
        <li>to send results of DUPR-rated divisions to DUPR;</li>
        <li>to support you, keep the Service secure, prevent fraud, and meet legal obligations;</li>
        <li>to fix and improve the Service.</li>
      </ul>

      <h2>3. Who sees it and who we share it with</h2>
      <ul>
        <li>
          <b>The tournament’s Director and staff</b> see what you entered when registering for their tournament, including
          your contact details, answers and payments, to run the event.
        </li>
        <li>
          <b>Anyone</b> can see names, team names, divisions, schedules, scores, standings and results on a tournament’s
          public pages and screens. Contact details, birth dates and payments are never public.
        </li>
        <li>
          <b>DUPR</b> receives players’ names, DUPR IDs and match results for DUPR-rated divisions.
        </li>
        <li>
          <b>Service providers</b> who process data for us to run the Service: Supabase (database and sign-in), Vercel
          (website hosting), Stripe (payments), Twilio (text messages), our email delivery provider, and Cloudflare (domain).
          They may use it only to provide their services to us.
        </li>
        <li>
          <b>When the law requires it</b>, or to protect people’s safety, our rights, or the Service; and to a buyer or
          successor if our business changes hands, under this policy.
        </li>
      </ul>
      <p>
        <b>Text messages:</b> we don’t sell or share mobile numbers or text-message consent with third parties or affiliates
        for their marketing or promotional purposes. The sharing described above excludes text-messaging opt-in data and
        consent; that information is not shared with any third parties.
      </p>

      <h2>4. How long we keep it</h2>
      <p>
        We keep tournament records, including registrations, payments and results, for as long as needed to run the
        tournament, keep its results, meet accounting and legal requirements, and resolve disputes. Practice tournaments are
        deleted after about two weeks. You can ask us to delete your information sooner, subject to those requirements.
      </p>

      <h2>5. Your choices and rights</h2>
      <ul>
        <li>Reply STOP to any text to stop texts; you can follow your team’s page instead.</li>
        <li>Ask us, or the tournament’s Director, to see, correct or delete your information.</li>
        <li>Depending on where you live, you may have more rights, such as to know what we collect, get a copy, correct or delete it, and not be treated differently for using these rights. Contact us to use them; we’ll verify your request first.</li>
      </ul>

      <h2>6. Children</h2>
      <p>
        The Service isn’t directed at children under 13, and we don’t knowingly collect their information except as entered
        by a parent or guardian registering them. If you think a child’s information was given to us without that, contact
        us and we’ll delete it.
      </p>

      <h2>7. Security</h2>
      <p>
        We use encryption in transit, access controls and trusted providers to protect your information. No system is
        perfectly secure, so we can’t guarantee it.
      </p>

      <h2>8. Where it’s stored</h2>
      <p>Your information is stored and processed in the United States.</p>

      <h2>9. Changes</h2>
      <p>We’ll post any changes here with a new effective date, and tell account holders of significant ones.</p>

      <h2>10. Contact</h2>
      <p>
        {owner} · <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>
      </p>
    </LegalPage>
  );
}
