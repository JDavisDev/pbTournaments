'use client';

// Once per page load: the service worker (Home Screen install, match alerts)
// and catching the browser's install prompt for the Add to Home button.
import { useEffect } from 'react';
import { listenForInstall } from '@/lib/install';
import { registerServiceWorker } from '@/lib/push';

export function AppSetup() {
  useEffect(() => {
    listenForInstall();
    if ('serviceWorker' in navigator) registerServiceWorker().catch(() => null);
  }, []);
  return null;
}
