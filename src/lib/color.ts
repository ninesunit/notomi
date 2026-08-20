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
