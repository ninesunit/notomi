import { Platform, View, type ViewStyle } from 'react-native';
import { NotomiReel } from '@/components/reel/NotomiReel';
import { useSafeArea } from '@/hooks/useSafeArea';

const WEB_REEL_STYLE =
  Platform.OS === 'web'
    ? ({
        height: '100dvh',
        maxHeight: '100dvh',
        overscrollBehaviorY: 'none',
        touchAction: 'pan-y',
      } as unknown as ViewStyle)
    : undefined;

export default function ReelPage() {
  const insets = useSafeArea();
  return (
    <View
      className="reel-viewport h-full w-full flex-1 overflow-hidden bg-paper"
      style={[WEB_REEL_STYLE, Platform.OS === 'web' ? undefined : { paddingBottom: insets.bottom }]}
    >
      <NotomiReel />
    </View>
  );
}
