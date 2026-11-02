'use client';

// "Add to Home": installs the site where the browser can, or shows the steps.
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button, Modal } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { promptInstall, useInstallWay, type InstallWay } from '@/lib/install';

const DISMISSED = 'courtside-add-to-home-dismissed';

/**
 * In the header on wider screens; on phones, where the header has no room
 * for it, a bar under the header that can be put away.
 */
export function AddToHomeButton({ bar = false }: { bar?: boolean }) {
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

/** The steps for this phone; for a browser that can prompt, a button. */
export function InstallSteps({ way }: { way: InstallWay }) {
  if (way === 'prompt') {
    return (
      <Button variant="primary" onClick={() => promptInstall()}>
        <Icon name="home" className="h-5 w-5" />
        Add {BRAND.name} to your Home Screen
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p>{BRAND.name} opens like an app, full screen, with your matches a tap away. It’s free and takes no space.</p>
      {way === 'ios' ? (
        <ol className="flex list-decimal flex-col gap-2 pl-6 text-lg">
          <li>
            Tap the <b>Share</b> button <Icon name="share" className="inline h-5 w-5 align-text-bottom" /> (at the bottom in
            Safari, at the top in Chrome).
          </li>
          <li>
            Scroll down and tap <b>Add to Home Screen</b>.
          </li>
          <li>
            Tap <b>Add</b>, then open {BRAND.name} from your Home Screen.
          </li>
        </ol>
      ) : (
        <ol className="flex list-decimal flex-col gap-2 pl-6 text-lg">
          <li>
            Open your browser’s menu (<b>⋮</b>, top right).
          </li>
          <li>
            Tap <b>Add to Home screen</b> or <b>Install app</b>.
          </li>
        </ol>
      )}
    </div>
  );
}
