import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { Slot, usePathname } from 'expo-router';
import { Copilot } from '@/components/Copilot';
import { EdgeSwipeArea, MobileTopBar, NavDrawer } from '@/components/Drawer';
import { IngestBanner } from '@/components/IngestBanner';
import { useSafeArea } from '@/hooks/useSafeArea';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { IngestProvider } from '@/hooks/useIngest';
import { ReminderProvider } from '@/hooks/useReminders';
import { UndoProvider } from '@/hooks/useUndo';

/** Below this the rail becomes a swipeable drawer (iPhone portrait, split-view iPad). */
export const RAIL_BREAKPOINT = 900;

/**
 * The shell's height, in the one unit that means "what you can actually see".
 * Cast because React Native's style types know nothing of CSS units; on native
 * this is simply not applied and flex does the work.
 */
const VIEWPORT =
  Platform.OS === 'web'
    ? ({ height: '100dvh', maxHeight: '100dvh', overflow: 'hidden' } as unknown as ViewStyle)
    : undefined;

/**
 * Workspace shell.
 *
 * The grey block that used to escape below "Your subjects" was a height-chain
 * problem, not a colour problem: the shell never established a bounded height,
 * so `h-full` on the sidebar resolved against an auto-height parent and the
 * sand-coloured rail painted past the viewport instead of scrolling inside it.
 *
 * Three things keep it contained now:
 *   1. html / body / #root are pinned to 100dvh in global.css with the document
 *      scrollport switched off, giving the percentage chain something real —
 *      and something *visible* — to resolve against.
 *   2. This root is a bounded row/column of exactly that height. It must never
 *      carry min-h-screen: 100vh is the large viewport on iOS, taller than what
 *      is on screen, which is what pushed the drawer's Sign out under the home
 *      indicator and made the whole page rubber-band.
 *   3. The main pane is `flex-1 min-w-0 h-full overflow-hidden`, so overflow is
 *      clipped here and scrolling happens inside each screen's own scroller
 *      (see ScreenScroll) rather than spilling out of the shell.
 *
 * There are no absolutely positioned backgrounds anywhere in the tree; every
 * surface colour is painted by an in-flow View that owns its own box.
 */
export default function WorkspaceLayout() {
  const { width } = useWindowDimensions();
  const insets = useSafeArea();
  const { user } = useAuth();
  const pathname = usePathname();
  const showRail = width >= RAIL_BREAKPOINT;

  const [drawer, setDrawer] = useState(false);
  const [asking, setAsking] = useState(false);

  /**
   * Navigating closes the drawer.
   *
   * Doing it here rather than in each row's onPress matters: `<Link asChild>`
   * injects its own onPress, and a handler of ours in that slot would replace
   * expo-router's and stop the link navigating at all.
   */
  useEffect(() => setDrawer(false), [pathname]);

  // The rail and the drawer are the same navigation in two shapes; only one can
  // be on screen, so a resize past the breakpoint has to dismiss the drawer.
  useEffect(() => {
    if (showRail) setDrawer(false);
  }, [showRail]);

  // Belt-and-braces against a deep link rendering a screen that calls useUid()
  // before the gate in app/_layout.tsx has settled.
  if (!user) {
    return (
      <View className="h-full w-full items-center justify-center bg-paper">
        <ActivityIndicator color="#B4552D" />
      </View>
    );
  }

  return (
    <IngestProvider>
      <UndoProvider>
        <ReminderProvider>
          {/* No padding on the root: the top bar carries the inset itself so
              its own background fills the notch area, rather than leaving a
              bare strip of paper above a floating bar. */}
          <View
            className={`w-full h-full bg-paper ${showRail ? 'flex-row' : 'flex-col'}`}
            style={VIEWPORT}
          >
            {showRail ? <Sidebar onAsk={() => setAsking(true)} /> : null}

            <View
              className={`flex-1 min-w-0 h-full bg-paper ${
                Platform.OS === 'web' ? 'overflow-hidden' : ''
              }`}
              style={showRail ? { paddingRight: insets.right } : undefined}
            >
              {showRail ? null : (
                <MobileTopBar onMenu={() => setDrawer(true)} onAsk={() => setAsking(true)} />
              )}

              <IngestBanner />

              {/* min-h-0 lets this shrink below its content so the banner is
                  never pushed off-screen and the scroller keeps its bounds. */}
              {showRail ? (
                <View className="flex-1 min-h-0">
                  <Slot />
                </View>
              ) : (
                <EdgeSwipeArea onOpen={() => setDrawer(true)}>
                  <Slot />
                </EdgeSwipeArea>
              )}
            </View>

            {showRail ? null : (
              <NavDrawer open={drawer} onClose={() => setDrawer(false)} pathname={pathname} />
            )}

            <Copilot visible={asking} onClose={() => setAsking(false)} />
          </View>
        </ReminderProvider>
      </UndoProvider>
    </IngestProvider>
  );
}
