import { useWindowDimensions } from 'react-native';

import { useSafeArea } from '@/hooks/useSafeArea';
import { PHONE, RAIL } from '@/lib/breakpoints';

/**
 * How much chrome sits above the scrolling content, as one number.
 *
 * Anything that pins itself — a sticky day strip, a section heading that
 * should stop under the tabs rather than behind them — needs to know where the
 * chrome ends. Every screen working that out for itself means every screen
 * getting a slightly different answer, and the one that guesses low renders a
 * heading underneath the tab row.
 *
 * Measured from the pieces rather than from the DOM, because the shell lays
 * them out in flow and their heights are ours: the top inset, the mobile
 * header, and the hub tab row when the screen has one.
 */

/** The compact mobile header: one 44pt row with 8pt above and below. */
export const MOBILE_HEADER_HEIGHT = 60;

/** The hub tab row: a 44pt target with 8pt of padding on a phone. */
export const HUB_TABS_HEIGHT = 60;

export function useChromeOffset({ hubTabs = false }: { hubTabs?: boolean } = {}): number {
  const insets = useSafeArea();
  const { width } = useWindowDimensions();

  // The rail replaces the mobile header entirely, and takes its height with it.
  const header = width >= RAIL ? 0 : MOBILE_HEADER_HEIGHT;
  const tabs = hubTabs ? (width < PHONE ? HUB_TABS_HEIGHT : 68) : 0;

  return insets.top + header + tabs;
}
