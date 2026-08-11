import type { ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeArea } from '@/hooks/useSafeArea';

/**
 * The workspace's main scroll container: `flex-1 h-full overflow-y-auto`.
 *
 * It lives inside the shell's clipped main pane, so long pages scroll here
 * instead of stretching the shell. `contentContainerClassName` carries the
 * padding and the reading-width cap; putting padding on the ScrollView itself
 * would shrink the scrollport and reintroduce clipped content at the bottom.
 *
 * The bottom inset is added to the content rather than the container for the
 * same reason: the last card has to clear the iPhone home indicator, but the
 * scrollport still has to run the full height or the page would end early.
 */
export function ScreenScroll({
  children,
  maxWidth = 1080,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  const insets = useSafeArea();

  return (
    <ScrollView
      className={`flex-1 h-full ${Platform.OS === 'web' ? 'overflow-y-auto' : ''}`}
      contentContainerClassName="px-5 py-7 md:px-10 md:py-10"
      contentContainerStyle={{
        // py-7 is 28; a little more than the inset so nothing sits flush
        // against the home bar.
        paddingBottom: 28 + insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View className="w-full self-center" style={{ maxWidth }}>
        {children}
      </View>
    </ScrollView>
  );
}
