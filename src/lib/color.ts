import { getTheme } from '@/lib/theme';

/**
 * Tinting a colour that came from the student, not from the palette.
 *
 * Subject colours are stored per subject in Firestore, so they are data rather
 * than theme: they cannot be a Tailwind token, and they arrive as a six-digit
 * hex string. Every surface that washes a card in its subject's colour does it
 * by concatenating two more hex digits onto that string — `${color}0F` for a
 * six-percent wash, `${color}59` for a thirty-five-percent border — which was
 * open-coded at thirty-four sites with twelve different alpha suffixes and no
 * name on any of them.
 *
 * One function instead, for two reasons. The obvious one is that `withAlpha`
 * says what `+ '0F'` does not. The real one is that dark mode needs these
 * ramps to change: six percent of a mid-tone hue over cream is a soft wash and
 * over near-black is nothing at all. A single choke point can be taught about
 * the theme later; thirty-four string concatenations cannot.
 */

/** The tint strengths in use, named. */
export const TINT = {
  /** A barely-there wash behind a card. */
  wash: 0.06,
  /** The usual fill behind a block or chip. */
  fill: 0.14,
  /** A stronger fill, for something selected or emphasised. */
  strong: 0.22,
  /** A visible edge without the full-strength colour. */
  edge: 0.35,
} as const;

/**
 * `#B4552D` at 14% → `#B4552D24`.
 *
 * Eight-digit hex rather than `rgba()` because these values are handed to
 * React Native style objects and to SVG attributes, and both take the hex form
 * on every platform the app runs on. `rgba()` strings are fine on web and are
 * not on native.
 */
export function withAlpha(hex: string, alpha: number): string {
  const base = normalise(hex);
  if (!base) return hex;

  const clamped = Math.max(0, Math.min(1, alpha));
  const channel = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

  return `${base}${channel}`;
}

/**
 * Reduces a colour to the six-digit form the alpha suffix can be appended to.
 *
 * Returns null for anything it does not recognise, so a caller can fall back to
 * the original string rather than render `undefinedFF`. Shorthand `#abc` is
 * accepted because it is valid CSS and a hand-edited palette entry might use
 * it; an eight-digit value already carries alpha and has its own replaced.
 */
function normalise(hex: string): string | null {
  if (typeof hex !== 'string') return null;
  const value = hex.trim();
  if (!value.startsWith('#')) return null;

  const digits = value.slice(1);
  if (digits.length === 3) {
    return `#${digits.split('').map((digit) => digit + digit).join('').toUpperCase()}`;
  }
  if (digits.length === 6 || digits.length === 8) {
    return `#${digits.slice(0, 6).toUpperCase()}`;
  }
  return null;
}

/**
 * A subject's colour, made legible on whichever ground is behind it.
 *
 * Slate `#4A5568` on near-black is 1.9:1 — a label nobody can read. But the
 * hue is the whole point: the student recognises "the purple one", so shifting
 * to a generic light grey would lose the thing the colour was for. So the hue
 * and (most of) the saturation are kept and only the lightness rises, far
 * enough to clear the dark surface and no further.
 *
 * Computed rather than looked up because older accounts hold colours no
 * current palette offers, and a table cannot answer for those.
 */
export function subjectInk(hex: string): string {
  if (getTheme() === 'light') return hex;

  const cached = liftCache.get(hex);
  if (cached) return cached;

  const lifted = liftForDark(hex);
  liftCache.set(hex, lifted);
  return lifted;
}

/**
 * A subject's colour as a surface behind something, rather than as the thing.
 *
 * The same weights do not carry over: six percent of a mid-tone hue over cream
 * is a soft wash, and over near-black it is nothing at all. Dark uses the
 * lifted colour at a heavier weight, which is what makes the tint visible
 * without turning a card into a block of colour.
 */
export function subjectTint(hex: string, weight: number): string {
  if (getTheme() === 'light') return withAlpha(hex, weight);
  return withAlpha(subjectInk(hex), Math.min(weight * 1.6, 0.9));
}

const liftCache = new Map<string, string>();

/** The ground the lift is measured against: `surface` in the dark palette. */
const DARK_GROUND = [28, 26, 22] as const;
const TARGET_CONTRAST = 5.5;

function liftForDark(hex: string): string {
  const base = normalise(hex);
  if (!base) return hex;

  const [r, g, b] = [1, 3, 5].map((index) => parseInt(base.slice(index, index + 2), 16) / 255);
  const [hue, lightness, saturation] = toHsl(r, g, b);
  // Capped, not preserved: a fully saturated hue lightens into neon rather
  // than into a pastel, and neon on near-black is harder to read, not easier.
  const capped = Math.min(saturation, 0.62);

  for (let step = 0; step <= 100; step += 1) {
    const candidate = fromHsl(hue, Math.min(1, lightness + step / 100), capped);
    if (contrast(candidate, DARK_GROUND) >= TARGET_CONTRAST) return toHex(candidate);
  }
  return toHex(fromHsl(hue, 1, capped));
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, lightness, 0];

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === r
      ? ((g - b) / delta + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / delta + 2) / 6
        : ((r - g) / delta + 4) / 6;
  return [hue, lightness, saturation];
}

function fromHsl(hue: number, lightness: number, saturation: number): [number, number, number] {
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255];

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (t: number) => {
    const shifted = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
    if (shifted < 1 / 2) return q;
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
    return p;
  };
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255];
}

function relativeLuminance([r, g, b]: readonly number[]): number {
  const linear = [r, g, b].map((value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function toHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b]
    .map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/**
 * The four steps of the burnout ramp: idle, light, moderate, heavy.
 *
 * Not the `-soft` tokens, which are pale enough that four of them in a row
 * read as one colour — a ramp has to step visibly or it is decoration. Not
 * subject colours either, since the meaning is workload rather than identity.
 *
 * The bucketing lives here too because it used to live in both callers with
 * *different thresholds*: the same week could sit amber on the dashboard and
 * green in the heatmap directly below it.
 */
const WORKLOAD: Record<'light' | 'dark', readonly [string, string, string, string]> = {
  light: ['#E9E5D9', '#DCE9E3', '#EAD9B6', '#E7BDB8'],
  dark: ['#26231D', '#1B3A30', '#463618', '#4A2320'],
};

export function workloadTint(workload: number, peak: number): string {
  const steps = WORKLOAD[getTheme()];
  if (workload === 0) return steps[0];

  const ratio = workload / Math.max(1, peak);
  return ratio <= 0.33 ? steps[1] : ratio <= 0.66 ? steps[2] : steps[3];
}
