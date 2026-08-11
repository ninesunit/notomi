import type { ReactNode } from 'react';
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeArea } from '@/hooks/useSafeArea';

/**
 * The workspace's main scroll container: `flex-1 h-full overflow-y-auto`.
 *
 * It lives inside the shell's clipped main pane, so long pages scroll here
 * instead of stretching the shell. The padding is on the content container, not
 * the ScrollView: padding on the scroller itself shrinks the scrollport and
 * reintroduces clipped content at the bottom.
 *
 * That padding is computed here rather than written as `px-5 md:px-10`, and the
 * reason is worth keeping: an inline `contentContainerStyle` *replaces* the
 * matching properties from `contentContainerClassName`, so adding a safe-area
 * paddingLeft silently deleted the gutter and every screen went edge to edge.
 * One source for the value, no override to lose.
 */

/** Gutter either side of the content. Wider once there is room for it. */
const GUTTER = 20;
const WIDE_GUTTER = 40;
const WIDE = 768;

export function ScreenScroll({
  children,
  maxWidth = 1080,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  const insets = useSafeArea();
  const { width } = useWindowDimensions();
  const gutter = width >= WIDE ? WIDE_GUTTER : GUTTER;

  return (
    <ScrollView
      className={`flex-1 h-full ${Platform.OS === 'web' ? 'overflow-y-auto' : ''}`}
      contentContainerStyle={{
        paddingTop: gutter + 8,
        // The inset is added to the gutter, never used instead of it: in
        // portrait it is zero, and landscape must not lose the gutter to it.
        paddingLeft: gutter + insets.left,
        paddingRight: gutter + insets.right,
        // A little more than the inset below, so the last card is clear of the
        // home indicator rather than touching it.
        paddingBottom: gutter + 8 + insets.bottom,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View className="w-full self-center" style={{ maxWidth }}>
        {children}
      </View>
    </ScrollView>
  );
}
