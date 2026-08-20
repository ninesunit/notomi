/**
 * The widths the layout changes at.
 *
 * These numbers already existed, scattered as literals: 640 in TodoRow, 700 in
 * Sheet, 768 in ScreenScroll, 900 in the workspace shell. Four files each with
 * their own idea of where a phone stops, and no way to tell whether two of them
 * disagreeing was a decision or an accident.
 *
 * Nothing is retuned here — every value is the one already in use. This is
 * naming, so the next screen that needs a phone layout picks a breakpoint
 * rather than inventing one.
 */

/**
 * A phone. Below this a screen needs its own layout, not a narrower desktop.
 *
 * Chosen as the general-purpose one: it is where TodoRow already stops fitting
 * its controls beside a title, and it sits below the smallest tablet in
 * portrait, so an iPad never gets phone treatment it does not need.
 */
export const PHONE = 640;

/** Below this a modal is a bottom sheet; above it, a centred dialog. */
export const SHEET = 700;

/** Where the content gutter widens, because there is room for it. */
export const WIDE = 768;

/** Where the persistent navigation rail replaces the drawer. */
export const RAIL = 900;

/** Where a seven-column week grid has room for full detail per column. */
export const GRID = 900;
