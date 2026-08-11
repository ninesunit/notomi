import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, useWindowDimensions, View } from 'react-native';
import { Slot, usePathname } from 'expo-router';
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
 * Workspace shell.
 *
 * The grey block that used to escape below "Your subjects" was a height-chain
 * problem, not a colour problem: the shell never established a bounded height,
 * so `h-full` on the sidebar resolved against an auto-height parent and the
 * sand-coloured rail painted past the viewport instead of scrolling inside it.
 *
 * Three things keep it contained now:
 *   1. html / body / #root are pinned to 100% height in global.css, giving the
 *      percentage chain something real to resolve against.
 *   2. This root is `flex-row w-full h-full min-h-screen bg-paper` — a bounded
 *      row that fills the viewport and no more.
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
            className={`w-full h-full min-h-screen bg-paper ${showRail ? 'flex-row' : 'flex-col'}`}
          >
            {showRail ? <Sidebar /> : null}

            <View
              className={`flex-1 min-w-0 h-full bg-paper ${
                Platform.OS === 'web' ? 'overflow-hidden' : ''
              }`}
              style={showRail ? { paddingRight: insets.right } : undefined}
            >
              {showRail ? null : <MobileTopBar onMenu={() => setDrawer(true)} />}

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
          </View>
        </ReminderProvider>
      </UndoProvider>
    </IngestProvider>
  );
}
