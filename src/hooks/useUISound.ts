import { useCallback } from 'react';

import {
  feedback,
  haptic,
  hapticsPreference,
  play,
  soundPreference,
  soundVolumePreference,
  type Cue,
} from '@/lib/sound';

/**
 * The single UI-feedback entry point for components that also render controls.
 * Low-level call sites can still import `feedback` directly; this hook adds the
 * live preferences Settings needs without creating another copy of them.
 */
export function useUISound() {
  const [sound, setSound] = soundPreference.use();
  const [volume, setVolume] = soundVolumePreference.use();
  const [haptics, setHaptics] = hapticsPreference.use();

  return {
    sound,
    setSound,
    volume,
    setVolume,
    haptics,
    setHaptics,
    play: useCallback((cue: Cue) => play(cue), []),
    haptic: useCallback((pattern?: number | number[]) => haptic(pattern), []),
    feedback: useCallback(
      (cue: Cue, pattern?: number | number[]) => feedback(cue, pattern),
      []
    ),
  };
}
