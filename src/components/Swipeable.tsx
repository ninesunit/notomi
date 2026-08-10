import { useRef, type ReactNode } from 'react';
import { Animated, PanResponder, Platform, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

/**
 * Swipe a row left to delete, right to complete.
 *
 * Built on PanResponder rather than a gesture library so it behaves the same in
 * a browser, in an installed PWA and in a native build. The action fires on
 * release past a threshold; anything short of that springs back, which is what
 * makes an accidental scroll harmless.
 *
 * Vertical intent wins: the responder only claims a gesture that is clearly
 * more horizontal than vertical, or the list would stop scrolling.
 */

const TRIGGER = 96;
const MAX_DRAG = 140;

export function SwipeableRow({
  children,
  onSwipeLeft,
  onSwipeRight,
  leftLabel = 'Delete',
  rightLabel = 'Done',
  enabled = true,
}: {
  children: ReactNode;
  /** Swiping left (revealing the right-hand action). */
  onSwipeLeft?: () => void;
  /** Swiping right (revealing the left-hand action). */
  onSwipeRight?: () => void;
  leftLabel?: string;
  rightLabel?: string;
  enabled?: boolean;
}) {
  const translate = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => {
        if (!enabled) return false;
        const horizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6;
        return horizontal && Math.abs(gesture.dx) > 12;
      },
      onPanResponderMove: (_event, gesture) => {
        // Refuse the direction that has no action wired up.
        if (gesture.dx < 0 && !onSwipeLeft) return;
        if (gesture.dx > 0 && !onSwipeRight) return;
        const clamped = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, gesture.dx));
        offset.current = clamped;
        translate.setValue(clamped);
      },
      onPanResponderRelease: (_event, gesture) => {
        const distance = offset.current;
        offset.current = 0;

        const settle = (callback?: () => void) => {
          Animated.spring(translate, {
            toValue: 0,
            useNativeDriver: Platform.OS !== 'web',
            bounciness: 0,
            speed: 18,
          }).start();
          callback?.();
        };

        if (distance <= -TRIGGER && onSwipeLeft) settle(onSwipeLeft);
        else if (distance >= TRIGGER && onSwipeRight) settle(onSwipeRight);
        else settle();

        // gesture is unused beyond the guard above but kept for clarity when
        // velocity-based triggering is added.
        void gesture;
      },
      onPanResponderTerminate: () => {
        offset.current = 0;
        Animated.spring(translate, {
          toValue: 0,
          useNativeDriver: Platform.OS !== 'web',
          bounciness: 0,
          speed: 18,
        }).start();
      },
    })
  ).current;

  if (!enabled) return <>{children}</>;

  const completeOpacity = translate.interpolate({
    inputRange: [0, TRIGGER],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const deleteOpacity = translate.interpolate({
    inputRange: [-TRIGGER, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View className="relative overflow-hidden">
      {/* Action backdrops sit behind the row and are revealed by the drag.
          The Animated wrapper carries opacity only: NativeWind does not apply
          className to Animated components, so the coloured panel is a plain
          View inside it. */}
      <View className="absolute inset-0 flex-row items-center justify-between">
        {onSwipeRight ? (
          <Animated.View style={{ opacity: completeOpacity, flex: 1, height: '100%' }}>
            <View className="h-full flex-row items-center gap-2 bg-pine px-5">
              <Feather name="check" size={16} color="#FFFFFF" />
              <Text className="text-sm font-semibold text-paper">{rightLabel}</Text>
            </View>
          </Animated.View>
        ) : (
          <View className="flex-1" />
        )}

        {onSwipeLeft ? (
          <Animated.View style={{ opacity: deleteOpacity, flex: 1, height: '100%' }}>
            <View className="h-full flex-row items-center justify-end gap-2 bg-rose px-5">
              <Text className="text-sm font-semibold text-paper">{leftLabel}</Text>
              <Feather name="trash-2" size={16} color="#FFFFFF" />
            </View>
          </Animated.View>
        ) : (
          <View className="flex-1" />
        )}
      </View>

      <Animated.View style={{ transform: [{ translateX: translate }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}
