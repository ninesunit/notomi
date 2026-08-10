import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Safe-area insets that actually hold in an installed PWA.
 *
 * react-native-safe-area-context reports zeros on web often enough to matter —
 * in a standalone iOS home-screen app that put the search bar underneath the
 * status bar and the clock. The CSS environment variables are authoritative
 * there, so they are measured directly and the larger of the two wins.
 *
 * Measured once on mount and again on orientation change: env() only resolves
 * after the document has laid out, and the values differ between portrait and
 * landscape on a notched device.
 */

type Insets = { top: number; bottom: number; left: number; right: number };

const ZERO: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

function measureEnv(): Insets {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return ZERO;

  try {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
    probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
    probe.style.paddingLeft = 'env(safe-area-inset-left, 0px)';
    probe.style.paddingRight = 'env(safe-area-inset-right, 0px)';
    document.body.appendChild(probe);

    const style = getComputedStyle(probe);
    const insets: Insets = {
      top: parseFloat(style.paddingTop) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
      right: parseFloat(style.paddingRight) || 0,
    };

    probe.remove();
    return insets;
  } catch {
    return ZERO;
  }
}

export function useSafeArea(): Insets {
  const provided = useSafeAreaInsets();
  const [measured, setMeasured] = useState<Insets>(ZERO);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const update = () => setMeasured(measureEnv());
    update();

    // A frame later as well: on a cold load env() can still resolve to 0 while
    // the viewport is settling, which is exactly when the header renders.
    const timer = setTimeout(update, 300);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return {
    top: Math.max(provided.top, measured.top),
    bottom: Math.max(provided.bottom, measured.bottom),
    left: Math.max(provided.left, measured.left),
    right: Math.max(provided.right, measured.right),
  };
}
