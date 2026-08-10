import { Platform } from 'react-native';

/**
 * UI sound, synthesised rather than shipped.
 *
 * Every tone is a couple of oscillators through a gain envelope, so there are
 * no audio assets to download, nothing to preload before the first tap, and no
 * licensing. It also means each cue can be tuned by ear in code.
 *
 * Deliberately restrained: a sound on every tap is exhausting, so only actions
 * with a real outcome make one — something saved, something finished, something
 * that went wrong.
 */

export type Cue =
  | 'tap'
  | 'toggle'
  | 'success'
  | 'error'
  | 'complete'
  | 'flip'
  | 'sent'
  | 'chime';

type Note = {
  /** Hertz. */
  frequency: number;
  /** Seconds from the cue's start. */
  at: number;
  duration: number;
  /** Peak gain, 0-1. Kept low: this plays over whatever else is running. */
  gain: number;
  type?: OscillatorType;
  /** Slide to this frequency across the note. */
  slideTo?: number;
};

/**
 * The palette. Intervals are consonant on purpose — a rising fifth reads as
 * "done", a falling minor third as "no".
 */
const CUES: Record<Cue, Note[]> = {
  tap: [{ frequency: 660, at: 0, duration: 0.05, gain: 0.05, type: 'sine' }],
  toggle: [{ frequency: 520, at: 0, duration: 0.06, gain: 0.06, type: 'triangle' }],
  flip: [{ frequency: 420, at: 0, duration: 0.09, gain: 0.05, slideTo: 620, type: 'sine' }],
  sent: [{ frequency: 700, at: 0, duration: 0.08, gain: 0.06, slideTo: 940, type: 'sine' }],
  success: [
    { frequency: 660, at: 0, duration: 0.1, gain: 0.07, type: 'sine' },
    { frequency: 990, at: 0.08, duration: 0.16, gain: 0.07, type: 'sine' },
  ],
  complete: [
    { frequency: 523.25, at: 0, duration: 0.1, gain: 0.07, type: 'sine' },
    { frequency: 659.25, at: 0.09, duration: 0.1, gain: 0.07, type: 'sine' },
    { frequency: 783.99, at: 0.18, duration: 0.22, gain: 0.08, type: 'sine' },
  ],
  error: [
    { frequency: 380, at: 0, duration: 0.12, gain: 0.07, type: 'triangle' },
    { frequency: 300, at: 0.1, duration: 0.18, gain: 0.06, type: 'triangle' },
  ],
  chime: [
    { frequency: 880, at: 0, duration: 0.25, gain: 0.09, type: 'sine' },
    { frequency: 1320, at: 0.06, duration: 0.3, gain: 0.05, type: 'sine' },
  ],
};

const STORAGE_KEY = 'notomi:sound';

let context: AudioContext | null = null;
let enabled = true;

function readPreference(): boolean {
  if (Platform.OS !== 'web') return true;
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

enabled = readPreference();

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  if (Platform.OS !== 'web') return;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    /* Private mode; the preference just does not persist. */
  }
}

/**
 * Lazily created, and only inside a user gesture — browsers refuse to start an
 * AudioContext otherwise, and a suspended one silently swallows everything.
 */
function audio(): AudioContext | null {
  if (Platform.OS !== 'web') return null;

  try {
    if (!context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    return null;
  }
}

export function play(cue: Cue): void {
  if (!enabled) return;

  const ctx = audio();
  if (!ctx) return;

  try {
    const start = ctx.currentTime;

    for (const note of CUES[cue]) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = note.type ?? 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, start + note.at);
      if (note.slideTo) {
        oscillator.frequency.exponentialRampToValueAtTime(
          note.slideTo,
          start + note.at + note.duration
        );
      }

      // Exponential ramps cannot touch zero, hence the epsilons. A linear cut
      // to silence clicks; this fades.
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + note.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.duration);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start + note.at);
      oscillator.stop(start + note.at + note.duration + 0.02);
    }
  } catch {
    /* Audio is a nicety; never let it break an interaction. */
  }
}

/**
 * A short vibration to go with a cue, where the platform offers one. iOS Safari
 * does not implement the Vibration API, so this is a no-op there rather than a
 * fallback — a fake haptic is worse than none.
 */
export function haptic(pattern: number | number[] = 8): void {
  if (!enabled || Platform.OS !== 'web') return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* Unsupported. */
  }
}

/** Sound plus haptic, which is what most call sites actually want. */
export function feedback(cue: Cue, vibration: number | number[] = 8): void {
  play(cue);
  haptic(vibration);
}
