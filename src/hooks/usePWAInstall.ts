import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function standalone(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
function ios(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

type InstallState = { prompt: InstallPrompt | null; installed: boolean };

let state: InstallState = { prompt: null, installed: standalone() };
let listening = false;
const listeners = new Set<(next: InstallState) => void>();

function publish(patch: Partial<InstallState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/**
 * Captured once for the whole app.
 *
 * `beforeinstallprompt` is a one-shot browser event. A hook that starts
 * listening only after sign-in can miss it on the login screen and leave the
 * Dashboard's Install button permanently unavailable. The module-level store
 * retains the event until any screen chooses to use it.
 */
function startListening(): void {
  if (listening || Platform.OS !== 'web' || typeof window === 'undefined') return;
  listening = true;
  const before = (event: Event) => {
    event.preventDefault();
    publish({ prompt: event as InstallPrompt });
  };
  const complete = () => publish({ installed: true, prompt: null });
  window.addEventListener('beforeinstallprompt', before);
  window.addEventListener('appinstalled', complete);
}

startListening();

export function usePWAInstall() {
  const [current, setCurrent] = useState<InstallState>(() => state);

  useEffect(() => {
    startListening();
    listeners.add(setCurrent);
    setCurrent(state);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  const install = useCallback(async () => {
    if (!state.prompt) return false;
    const pending = state.prompt;
    await pending.prompt();
    const result = await pending.userChoice;
    // Browser install prompts are single-use, including after dismissal.
    publish({ prompt: null });
    if (result.outcome === 'accepted') {
      publish({ installed: true });
      return true;
    }
    return false;
  }, []);

  return {
    installed: current.installed,
    canPrompt: Boolean(current.prompt),
    isIOS: ios(),
    install,
  };
}
