import { ActivityIndicator, Platform, Text, useWindowDimensions, View } from 'react-native';
import { Slot } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlobalSearch } from '@/components/GlobalSearch';
import { IngestBanner } from '@/components/IngestBanner';
import { BottomTabs, Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { IngestProvider } from '@/hooks/useIngest';

/** Below this the rail becomes a bottom bar (iPhone portrait, split-view iPad). */
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
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const showRail = width >= RAIL_BREAKPOINT;

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
      <View
        className={`w-full h-full min-h-screen bg-paper ${showRail ? 'flex-row' : 'flex-col'}`}
        style={{ paddingTop: showRail ? 0 : insets.top }}
      >
        {showRail ? <Sidebar /> : null}

        <View
          className={`flex-1 min-w-0 h-full bg-paper ${Platform.OS === 'web' ? 'overflow-hidden' : ''}`}
        >
          {/* Without the rail there is nowhere else for the wordmark or search
              to live, so a compact bar carries both. */}
          {showRail ? null : (
            <View className="flex-row items-center gap-3 border-b border-line bg-sand px-4 py-2.5">
              <View className="h-7 w-7 items-center justify-center rounded-lg bg-ink">
                <Text className="text-xs font-bold text-paper">N</Text>
              </View>
              <View className="flex-1">
                <GlobalSearch />
              </View>
            </View>
          )}

          <IngestBanner />
          {/* min-h-0 lets this shrink below its content so the banner is never
              pushed off-screen and the scroller keeps its own bounds. */}
          <View className="flex-1 min-h-0">
            <Slot />
          </View>
        </View>

        {showRail ? null : (
          <View style={{ paddingBottom: insets.bottom }} className="bg-sand">
            <BottomTabs />
          </View>
        )}
      </View>
    </IngestProvider>
  );
}
