import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  View,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';
import { feedback, type Cue } from '@/lib/sound';

/**
 * The app's motion vocabulary.
 *
 * Three things, used everywhere, so movement is consistent rather than
 * decorative: content arrives, lists stagger, and anything pressable responds
 * under the finger. Durations sit around 200-320ms — long enough to read as
 * motion, short enough that a student tapping quickly never waits on it.
 *
 * Everything degrades to a plain View if animation is unavailable, and honours
 * prefers-reduced-motion.
 */

function prefersReducedMotion(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Fades and lifts content into place. `index` staggers a list. */
export function FadeIn({
  children,
  index = 0,
  distance = 12,
  duration = 280,
  style,
}: {
  children: ReactNode;
  index?: number;
  distance?: number;
  duration?: number;
  style?: ViewStyle;
}) {
  const progress = useRef(new Animated.Value(prefersReducedMotion() ? 1 : 0)).current;

  useEffect(() => {
    if (prefersReducedMotion()) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      // Capped so a long list does not take a second to finish arriving.
      delay: Math.min(index * 45, 320),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [progress, index, duration]);

  return (
    <Animated.View
      style={[
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [distance, 0],
              }),
            },
          ],
        },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A pressable that scales under the finger and can make a sound.
 *
 * The scale is small — 0.97 — because anything more reads as a bounce rather
 * than a press, and it has to survive being used on a full-width card.
 */
export function Tappable({
  children,
  onPress,
  cue = 'tap',
  disabled = false,
  className = '',
  style,
  accessibilityLabel,
  accessibilityRole = 'button',
}: {
  children: ReactNode;
  /** The event is forwarded so a Tappable can be the child of a Link. */
  onPress?: (event: GestureResponderEvent) => void;
  /** Sound to play on press; null for silence. */
  cue?: Cue | null;
  disabled?: boolean;
  className?: string;
  style?: ViewStyle;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'none';
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      speed: 40,
      bounciness: 0,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPressIn={() => !prefersReducedMotion() && spring(0.97)}
      onPressOut={() => spring(1)}
      onPress={(event) => {
        if (cue) feedback(cue);
        onPress?.(event);
      }}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <View className={className}>{children}</View>
      </Animated.View>
    </Pressable>
  );
}

/**
 * Collapses and expands its child.
 *
 * Height cannot be animated without measuring, so this animates opacity and a
 * translate instead and lets the layout jump. That is a deliberate trade: a
 * measured height animation needs onLayout plumbing through every caller, and
 * at these sizes the difference is not visible.
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    if (prefersReducedMotion()) {
      progress.setValue(open ? 1 : 0);
      return;
    }
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? 220 : 140,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [open, progress]);

  if (!open) return null;

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A number that counts up to its value — for streaks and totals.
 *
 * An Animated.Value cannot drive text, so a listener mirrors it into state.
 * That is a re-render per frame, which is why this is reserved for the handful
 * of headline numbers rather than used on every count in a list.
 */
export function Counter({
  value,
  render,
}: {
  value: number;
  render: (shown: number) => ReactNode;
}) {
  const animated = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(value);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }

    animated.setValue(0);
    const listener = animated.addListener(({ value: progress }) =>
      setShown(Math.round(progress * value))
    );

    const animation = Animated.timing(animated, {
      toValue: 1,
      duration: 500,
      easing: Easing.out(Easing.cubic),
      // The listener reads the value on the JS thread, so it cannot be native.
      useNativeDriver: false,
    });
    animation.start(({ finished }) => finished && setShown(value));

    return () => {
      animation.stop();
      animated.removeListener(listener);
    };
  }, [value, animated]);

  return <>{render(shown)}</>;
}
