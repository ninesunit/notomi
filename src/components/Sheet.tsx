import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

/**
 * One container, two presentations.
 *
 * On a phone this is a bottom sheet that slides up from the edge the thumb is
 * already near; on a wide screen it is the centred dialog a mouse expects.
 * Keeping both in one component means every modal in the app gets the native
 * feel without each screen branching on width.
 */

const SHEET_BREAKPOINT = 700;

export function Sheet({
  visible,
  onClose,
  title,
  icon,
  children,
  footer,
  /** Caps the scrollable body on desktop; the sheet uses a fraction of height. */
  maxHeight = 460,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ComponentProps<typeof Feather>['name'];
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: number;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sheet = width < SHEET_BREAKPOINT;

  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [visible, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <Modal
      visible={visible}
      transparent
      // The OS slide would fight the sheet's own animation.
      animationType={sheet ? 'none' : 'fade'}
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        className={`flex-1 bg-ink/40 ${sheet ? 'justify-end' : 'items-center justify-center px-5'}`}
      >
        {/* The scrim closes; the panel must not, so it swallows its own press. */}
        <Pressable
          onPress={() => undefined}
          className={sheet ? 'w-full' : 'w-full max-w-md'}
          style={sheet ? undefined : { maxWidth: 448 }}
        >
          {/* Animated.View carries the transform only. NativeWind does not
              apply className to Animated components, so anything styled with
              utilities has to live on a plain View inside it — the sheet
              rendered with no background at all until this was split. */}
          <Animated.View style={sheet ? { transform: [{ translateY }] } : undefined}>
          <View
            className={`overflow-hidden border border-line bg-surface ${
              sheet ? 'rounded-t-3xl' : 'rounded-2xl'
            }`}
          >
            {sheet ? (
              // Grab handle: the affordance that says "this drags/dismisses".
              <View className="items-center pb-1 pt-2.5">
                <View className="h-1 w-10 rounded-full bg-line" />
              </View>
            ) : null}

            <View className="flex-row items-center gap-3 border-b border-line px-5 py-4">
              {icon ? (
                <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
                  <Feather name={icon} size={16} color="#B4552D" />
                </View>
              ) : null}
              <Text className="flex-1 text-[15px] font-semibold text-ink">{title}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                hitSlop={8}
                className="h-8 w-8 items-center justify-center rounded-lg"
              >
                <Feather name="x" size={16} color="#6F6A5F" />
              </Pressable>
            </View>

            <ScrollView
              style={{ maxHeight: sheet ? height * 0.6 : maxHeight }}
              contentContainerClassName="gap-4 p-5"
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>

            {footer ? (
              <View
                className="flex-row items-center gap-2 border-t border-line px-5 py-4"
                // Clear of the iPhone home indicator when docked to the edge.
                style={{ paddingBottom: sheet ? 16 + insets.bottom : 16 }}
              >
                {footer}
              </View>
            ) : sheet ? (
              <View style={{ height: insets.bottom }} />
            ) : null}
          </View>
          </Animated.View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** True when modals on this viewport should present as bottom sheets. */
export function useIsSheet(): boolean {
  const { width } = useWindowDimensions();
  return width < SHEET_BREAKPOINT;
}
