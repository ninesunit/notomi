import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeArea } from '@/hooks/useSafeArea';
import { Icon } from '@/components/Icon';
import { SHEET as SHEET_BREAKPOINT } from '@/lib/breakpoints';

/**
 * One container, two presentations.
 *
 * On a phone this is a bottom sheet that slides up from the edge the thumb is
 * already near; on a wide screen it is the centred dialog a mouse expects.
 * Keeping both in one component means every modal in the app gets the native
 * feel without each screen branching on width.
 */



export function Sheet({
  visible,
  onClose,
  title,
  icon,
  children,
  footer,
  /** Caps the scrollable body on desktop; the sheet uses a fraction of height. */
  maxHeight = 460,
  /**
   * Whether tapping the scrim closes the sheet.
   *
   * Off for anything holding work that cost something to produce — a scan
   * discarded by a stray tap outside the panel is work the student has to pay
   * for again.
   */
  dismissOnScrim = true,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ComponentProps<typeof Icon>['name'];
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: number;
  dismissOnScrim?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeArea();
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
      {/*
        The scrim is a SIBLING behind the panel, never an ancestor of it.

        react-native-web renders Pressable as a <button>, and a button treats
        Space and Enter as activation. With the panel nested inside the scrim,
        every space typed into a field bubbled up and dismissed the sheet — you
        could not put a space in a subject's name.
      */}
      <View
        className={`flex-1 ${sheet ? 'justify-end' : 'items-center justify-center px-5'}`}
      >
        <Pressable
          accessibilityRole={dismissOnScrim ? 'button' : 'none'}
          accessibilityLabel={dismissOnScrim ? 'Close' : undefined}
          onPress={dismissOnScrim ? onClose : undefined}
          // Keyboard activation is what caused the bug; the scrim is a
          // pointer target only, and Escape already closes the modal.
          focusable={false}
          style={StyleSheet.absoluteFill}
          className="bg-ink/40"
        />

        <View
          pointerEvents="box-none"
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
                  <Icon name={icon} size={16} tone="accent" />
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
                <Icon name="x" size={16} tone="muted" />
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
        </View>
      </View>
    </Modal>
  );
}

/** True when modals on this viewport should present as bottom sheets. */
export function useIsSheet(): boolean {
  const { width } = useWindowDimensions();
  return width < SHEET_BREAKPOINT;
}
