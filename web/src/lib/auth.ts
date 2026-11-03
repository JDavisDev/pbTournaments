// Director sign-in: Supabase Auth in production, a local account in local mode.
import { takeCaptchaToken } from './captcha';
import { demoGuest, isLocalMode } from './config';
import { getLocalUser, localCall, setLocalUser, type LocalUser } from './localClient';
import type { PlayerProfile } from './profileTypes';
import { supabase } from './supabase';

export type AuthUser = LocalUser;

type Listener = (user: AuthUser | null) => void;

interface Auth {
  current(): Promise<AuthUser | null>;
  subscribe(listener: Listener): () => void;
  signIn(email: string, password: string): Promise<void>;
  /**
   * 'confirm-email' when Supabase needs the address confirmed first. The
   * profile then waits on the account (pendingProfile) until it's logged in.
   */
  signUp(email: string, password: string, profile?: PlayerProfile): Promise<'signed-in' | 'confirm-email'>;
  /** Supabase only: details from a sign-up that had to confirm its email, not saved yet. */
  pendingProfile?(): Promise<PlayerProfile | null>;
  clearPendingProfile?(): Promise<void>;
  /** Demo sites: the shared guest account (Supabase), or a local guest without an email. */
  signInAsGuest(): Promise<void>;
  /** Supabase only: a one-time sign-in link by email, for an existing account. */
  emailLink?(email: string): Promise<void>;
  signOut(): Promise<void>;
}

const remoteAuth: Auth = {
  async current() {
    const { data } = await supabase().auth.getSession();
    const u = data.session?.user;
    return u ? { id: u.id, email: u.email || null } : null;
  },
  subscribe(listener) {
    const { data } = supabase().auth.onAuthStateChange((_event, session) =>
      listener(session ? { id: session.user.id, email: session.user.email || null } : null),
    );
    return () => data.subscription.unsubscribe();
  },
  // Sign-up, log-in and sign-in links carry a captcha token when it's on (lib/captcha).
  async signIn(email, password) {
    const { error } = await supabase().auth.signInWithPassword({ email, password, options: { captchaToken: takeCaptchaToken() } });
    if (error) throw new Error(error.message);
  },
  async signUp(email, password, profile) {
    const { data, error } = await supabase().auth.signUp({
      email,
      password,
      options: {
        captchaToken: takeCaptchaToken(),
        emailRedirectTo: window.location.origin,
        // When they agreed to the Terms of Service and Privacy Policy (the sign-up checkbox), and what
        // they filled in, kept with the account until it's confirmed: the link may open on another browser.
        data: { terms_accepted_at: new Date().toISOString(), ...(profile ? { pending_profile: profile } : {}) },
      },
    });
    if (error) throw new Error(error.message);
    return data.session ? 'signed-in' : 'confirm-email';
  },
  async pendingProfile() {
    const { data } = await supabase().auth.getUser();
    return (data.user?.user_metadata?.pending_profile as PlayerProfile | undefined) ?? null;
  },
  async clearPendingProfile() {
    await supabase().auth.updateUser({ data: { pending_profile: null } });
  },
  async signInAsGuest() {
    const { email, password } = demoGuest;
    if (!email || !password) {
      throw new Error('Guest access isn’t set up: set NEXT_PUBLIC_DEMO_GUEST_EMAIL and NEXT_PUBLIC_DEMO_GUEST_PASSWORD.');
    }
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    if (error) throw new Error(`Guest sign-in failed: ${error.message}`);
  },
  async emailLink(email) {
    // Only logs in: signing up goes through the form, with its Terms checkbox.
    const { error } = await supabase().auth.signInWithOtp({
      email,
      options: { captchaToken: takeCaptchaToken(), emailRedirectTo: window.location.origin, shouldCreateUser: false },
    });
    if (error) throw new Error(/signups? not allowed/i.test(error.message) ? 'No account with that email yet. Sign up first.' : error.message);
  },
  async signOut() {
    await supabase().auth.signOut();
  },
};

const localListeners = new Set<Listener>();
const notifyLocal = (user: AuthUser | null) => localListeners.forEach((l) => l(user));

const localAuth: Auth = {
  async current() {
    const saved = getLocalUser();
    if (!saved) return null;
    const user = await localCall<AuthUser | null>('currentUser', [saved.id]).catch(() => saved);
    if (!user) setLocalUser(null); // the local database was rebuilt
    return user;
  },
  subscribe(listener) {
    localListeners.add(listener);
    const onStorage = () => listener(getLocalUser());
    window.addEventListener('storage', onStorage);
    return () => {
      localListeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  },
  async signIn(email, password) {
    const user = await localCall<AuthUser>('signIn', [email, password]);
    setLocalUser(user);
    notifyLocal(user);
  },
  async signInAsGuest() {
    const user = await localCall<AuthUser>('signInGuest');
    setLocalUser(user);
    notifyLocal(user);
  },
  async signUp(email, password) {
    const user = await localCall<AuthUser>('signUp', [email, password]);
    setLocalUser(user);
    notifyLocal(user);
    return 'signed-in';
  },
  async signOut() {
    setLocalUser(null);
    notifyLocal(null);
  },
};

export const auth: Auth = isLocalMode ? localAuth : remoteAuth;

/** A demo guest: the shared guest account, or a local guest (no email). */
export const isGuest = (user: AuthUser) => !user.email || user.email.toLowerCase() === demoGuest.email;
