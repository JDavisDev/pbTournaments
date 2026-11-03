'use client';

// Cloudflare Turnstile in front of sign-up and log-in, once
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. Supabase checks the token (Auth → Bot
// and Abuse Protection), so bots calling Supabase directly are stopped too;
// most people never see a challenge. Unset: no widget, and no token is sent.
import { useEffect, useRef } from 'react';

const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: Promise<Turnstile> | null = null;
function loadTurnstile() {
  script ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    tag.async = true;
    tag.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile didn’t load')));
    tag.onerror = () => {
      script = null;
      reject(new Error('Turnstile didn’t load'));
    };
    document.head.appendChild(tag);
  });
  return script;
}

// One widget on screen at a time (the log-in or the sign-up form).
let token: string | undefined;
let widget: string | undefined;

/**
 * The token for one Supabase auth call (each is good once), then a fresh
 * challenge for the next try. Undefined when the captcha is off.
 */
export function takeCaptchaToken(): string | undefined {
  if (!siteKey) return undefined;
  const t = token;
  if (!t) throw new Error('One moment: we’re checking this isn’t a bot. Try again in a second.');
  token = undefined;
  if (widget) window.turnstile?.reset(widget);
  return t;
}

/** The Turnstile widget, for a form that signs up or logs in. Nothing when the captcha is off. */
export function Captcha() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !box.current) return;
    const el = box.current;
    let id: string | undefined;
    let gone = false;
    loadTurnstile()
      .then((t) => {
        if (gone) return;
        id = t.render(el, {
          sitekey: siteKey,
          theme: 'auto',
          size: 'flexible',
          callback: (value: string) => (token = value),
          'expired-callback': () => (token = undefined),
          'error-callback': () => (token = undefined),
        });
        widget = id;
      })
      .catch(() => {});
    return () => {
      gone = true;
      token = undefined;
      if (id) window.turnstile?.remove(id);
      if (widget === id) widget = undefined;
    };
  }, []);
  return siteKey ? <div ref={box} className="min-h-[65px]" /> : null;
}
