import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, Text, View } from 'react-native';

/**
 * A flashcard that flips in 3D.
 *
 * Both faces are stacked and rotated in opposite directions around the Y axis,
 * with backface-visibility hiding whichever is turned away. That is the only
 * approach that keeps a single shared box — animating opacity instead would
 * cross-fade two cards rather than turn one over.
 *
 * On native, backfaceVisibility is honoured by the view itself; on web it needs
 * the style passed through explicitly, hence the platform-specific object.
 */

const HIDDEN_BACKFACE = Platform.select({
  web: { backfaceVisibility: 'hidden' as const, WebkitBackfaceVisibility: 'hidden' },
  default: { backfaceVisibility: 'hidden' as const },
}) as Record<string, unknown>;

export function FlipCard({
  front,
  back,
  flipped,
  onFlip,
  height = 300,
}: {
  front: string;
  back: string;
  flipped: boolean;
  onFlip: () => void;
  height?: number;
}) {
  const progress = useRef(new Animated.Value(flipped ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: flipped ? 1 : 0,
      duration: 380,
      easing: Easing.inOut(Easing.cubic),
      // The transform runs on the UI thread; nothing here reads layout.
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [flipped, progress]);

  const frontSpin = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });
  const backSpin = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['180deg', '360deg'],
  });

  // Positioning stays in inline styles rather than utility classes: the faces
  // must resolve against this Pressable, and mixing className with a style
  // array left that dependent on merge order, which put both faces outside the
  // card's box.
  const face = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    height,
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={flipped ? 'Show the question' : 'Show the answer'}
      onPress={onFlip}
      style={{ height, width: '100%', position: 'relative' }}
    >
      <Animated.View
        style={[
          face,
          { transform: [{ perspective: 1200 }, { rotateY: frontSpin }] },
          HIDDEN_BACKFACE,
        ]}
      >
        <Face label="Question" tone="paper" text={front} hint="Tap to reveal" />
      </Animated.View>

      <Animated.View
        style={[
          face,
          { transform: [{ perspective: 1200 }, { rotateY: backSpin }] },
          HIDDEN_BACKFACE,
        ]}
      >
        <Face label="Answer" tone="pine" text={back} hint="Tap to flip back" />
      </Animated.View>
    </Pressable>
  );
}

function Face({
  label,
  text,
  tone,
  hint,
}: {
  label: string;
  text: string;
  tone: 'paper' | 'pine';
  hint: string;
}) {
  return (
    <View
      className={`h-full w-full overflow-hidden rounded-2xl border ${
        tone === 'pine' ? 'border-pine/30 bg-pine-soft' : 'border-line bg-surface'
      }`}
    >
      <View
        className={`flex-row items-center justify-between px-5 py-3 ${
          tone === 'pine' ? 'bg-pine/10' : 'bg-sand'
        }`}
      >
        <Text
          className={`text-[11px] font-bold uppercase tracking-wider ${
            tone === 'pine' ? 'text-pine' : 'text-muted'
          }`}
        >
          {label}
        </Text>
        <Text className="text-[11px] text-subtle">{hint}</Text>
      </View>

      {/* Long answers scroll inside the card rather than overflowing it. */}
      <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-6">
        <Text
          className={`text-center leading-7 ${
            text.length > 160 ? 'text-[15px]' : 'text-[19px]'
          } ${tone === 'pine' ? 'text-ink' : 'text-ink'}`}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}
