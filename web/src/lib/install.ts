// Adding the site to the Home Screen. Chrome and Android offer an install
// prompt (beforeinstallprompt), caught early by AppSetup; iPhones don't, so
// players get the steps instead.
import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function listenForInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    changed();
  });
}

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(navigator.userAgent);

/** Opened from the Home Screen (or as an installed app). */
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/**
 * 'prompt': the browser can install it in one tap. 'ios' / 'android': the
 * player follows steps. null: installed already, or not offered (desktop).
 */
export type InstallWay = 'prompt' | 'ios' | 'android' | null;

function way(): InstallWay {
  if (installed || isStandalone()) return null;
  if (deferred) return 'prompt';
  if (isIos()) return 'ios';
  if (isAndroid()) return 'android';
  return null;
}

export function useInstallWay(): InstallWay {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    way,
    () => null,
  );
}

/** Shows the browser's install prompt. */
export async function promptInstall() {
  if (!deferred) return;
  const e = deferred;
  deferred = null;
  await e.prompt();
  if ((await e.userChoice).outcome === 'accepted') installed = true;
  changed();
}
