'use client';

// Signing up as a player: who you are, once. Registering for a tournament then
// only asks which events.
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Empty, Field, Input, Select } from '@/components/ui';
import { isDemoMode } from '@/lib/config';
import { clearProfile, saveProfile, useProfile, type PlayerProfile } from '@/lib/profile';

const blank: PlayerProfile = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  sms_opt_in: true,
  gender: '',
  birth_date: '',
  dupr_doubles: '',
  dupr_singles: '',
  self_rating: '',
  dupr_id: '',
};

export function ProfileForm() {
  const profile = useProfile();
  if (!isDemoMode) return <Empty>Player profiles aren’t available yet.</Empty>;
  // Keyed so the Test menu's fake players show up here too.
  return <Fields key={profile?.email ?? 'new'} saved={profile} />;
}

function Fields({ saved }: { saved: PlayerProfile | null }) {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [p, setP] = useState<PlayerProfile>(saved ?? blank);
  const set = <K extends keyof PlayerProfile>(key: K, value: PlayerProfile[K]) => setP({ ...p, [key]: value });

  return (
    <form
      className="mx-auto flex max-w-md flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        saveProfile({ ...p, email: p.email.trim().toLowerCase() });
        router.push(next?.startsWith('/') ? next : '/');
      }}
    >
      <div>
        <h1 className="text-4xl">{saved ? 'Your profile' : 'Sign up'}</h1>
        <p className="mt-1 text-muted">Enter this once, then registering for a tournament takes a click. Saved on this device for now.</p>
      </div>
      <Card className="flex flex-col gap-3 p-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input required autoComplete="given-name" value={p.first_name} onChange={(e) => set('first_name', e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input required autoComplete="family-name" value={p.last_name} onChange={(e) => set('last_name', e.target.value)} />
          </Field>
        </div>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={p.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Mobile number" hint="We text you which court to go to.">
          <Input type="tel" autoComplete="tel" placeholder="(555) 123-4567" value={p.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Gender and age, for divisions that need them</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Gender">
              <Select value={p.gender} onChange={(e) => set('gender', e.target.value as PlayerProfile['gender'])}>
                <option value="">Choose…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </Select>
            </Field>
            <Field label="Date of birth">
              <Input type="date" autoComplete="bday" value={p.birth_date} onChange={(e) => set('birth_date', e.target.value)} />
            </Field>
          </div>
        </details>
      </Card>
      <Button variant="primary" type="submit" className="h-14 text-base">
        {saved ? 'Save' : 'Sign up'}
      </Button>
      {saved && (
        <Button type="button" variant="ghost" className="text-late" onClick={() => (clearProfile(), router.push('/'))}>
          Remove my profile from this device
        </Button>
      )}
    </form>
  );
}
