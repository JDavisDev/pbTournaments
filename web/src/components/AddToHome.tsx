'use client';

// "Add to Home": installs the site where the browser can, or shows the steps.
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button, Modal } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { promptInstall, useInstallWay, type InstallWay } from '@/lib/install';
import { AlertSteps, AndroidInstallSteps, IosInstallSteps } from './HelpSteps';

const DISMISSED = 'courtside-add-to-home-dismissed';

/** A row in the phone menu (PhoneMenu). */
export const menuItem = 'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-lg font-medium hover:bg-surface-2';

/**
 * In the header on wider screens; on phones, where the header has no room
 * for it, a bar under the header that can be put away.
 */
export function AddToHomeButton({ bar = false, item = false }: { bar?: boolean; item?: boolean }) {
  const way = useInstallWay();
  const [steps, setSteps] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return bar && typeof window !== 'undefined' && localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });
  if (!way || dismissed) return null;
  const add = () => (way === 'prompt' ? promptInstall() : setSteps(true));
  const dialog = (
    <Modal open={steps} onClose={() => setSteps(false)} title="Add to your Home Screen">
      <InstallSteps way={way} />
    </Modal>
  );
  if (item) {
    return (
      <>
        <button type="button" className={menuItem} onClick={add}>
          <Icon name="home" className="h-5 w-5" />
          Add to Home Screen
        </button>
        {dialog}
      </>
    );
  }
  if (bar) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-4 py-1.5 sm:hidden">
        <button type="button" className="inline-flex min-h-11 flex-1 items-center gap-2 text-left font-medium" onClick={add}>
          <Icon name="home" className="h-5 w-5 shrink-0" />
          Add to Home Screen
        </button>
        <button
          type="button"
          className="h-11 rounded-full px-3 text-sm text-muted hover:bg-surface-2"
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED, '1');
            } catch {}
            setDismissed(true);
          }}
        >
          Not now
        </button>
        {dialog}
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        title="Add to your Home Screen"
        className="hidden h-11 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium whitespace-nowrap hover:bg-surface-2 sm:inline-flex"
        onClick={add}
      >
        <Icon name="home" className="h-5 w-5" />
        Add to Home
      </button>
      {dialog}
    </>
  );
}

/** The steps for this phone (or, where the browser can prompt, a button), then how to turn on alerts. */
export function InstallSteps({ way, alerts = true }: { way: InstallWay; alerts?: boolean }) {
  return (
    <div className="flex flex-col gap-3 text-lg">
      {way === 'prompt' ? (
        <Button variant="primary" onClick={() => promptInstall()}>
          <Icon name="home" className="h-5 w-5" />
          Add {BRAND.name} to your Home Screen
        </Button>
      ) : (
        <>
          <p className="text-base">{BRAND.name} opens like an app, full screen, with your matches a tap away. It’s free and takes no space.</p>
          {way === 'ios' ? <IosInstallSteps /> : <AndroidInstallSteps />}
        </>
      )}
      {alerts && (
        <>
          <h3 className="mt-2 text-xl">Then turn on match alerts</h3>
          <p className="text-base text-muted">A notification when your match is called to a court, with a tap to report the score.</p>
          <AlertSteps />
        </>
      )}
    </div>
  );
}
