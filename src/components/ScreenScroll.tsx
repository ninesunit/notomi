import type { ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';

/**
 * The workspace's main scroll container: `flex-1 h-full overflow-y-auto`.
 *
 * It lives inside the shell's clipped main pane, so long pages scroll here
 * instead of stretching the shell. `contentContainerClassName` carries the
 * padding and the reading-width cap; putting padding on the ScrollView itself
 * would shrink the scrollport and reintroduce clipped content at the bottom.
 */
export function ScreenScroll({
  children,
  maxWidth = 1080,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <ScrollView
      className={`flex-1 h-full ${Platform.OS === 'web' ? 'overflow-y-auto' : ''}`}
      contentContainerClassName="px-5 py-7 md:px-10 md:py-10"
      showsVerticalScrollIndicator={false}
    >
      <View className="w-full self-center" style={{ maxWidth }}>
        {children}
      </View>
    </ScrollView>
  );
}
