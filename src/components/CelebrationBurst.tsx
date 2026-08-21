import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, Platform, StyleSheet, View } from 'react-native';

const COLORS = ['#B4552D', '#2E6F5E', '#B4832A', '#4C5FA8', '#8A4B86'];

/**
 * A tiny, local celebration. It is intentionally twelve views rather than a
 * confetti dependency or a remote animation: the whole burst lasts 720ms,
 * ignores touches, honours reduced motion, and costs no network request.
 */
export function CelebrationBurst({ burstKey }: { burstKey: number }) {
  const [visible, setVisible] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;

  const reduced =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const particles = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const angle = (Math.PI * 2 * index) / 12 + (index % 2 ? 0.12 : -0.08);
        const distance = 74 + (index % 3) * 18;
        return {
          id: index,
          color: COLORS[index % COLORS.length],
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          rotate: `${index * 41}deg`,
        };
      }),
    []
  );

  useEffect(() => {
    if (burstKey <= 0 || reduced) return;
    setVisible(true);
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 720,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => finished && setVisible(false));
    return () => animation.stop();
  }, [burstKey, progress, reduced]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="none" presentationStyle="overFullScreen">
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View className="absolute inset-0 items-center justify-center">
          {particles.map((particle) => (
            <Animated.View
              key={particle.id}
              style={{
                position: 'absolute',
                width: particle.id % 3 === 0 ? 6 : 8,
                height: particle.id % 3 === 0 ? 14 : 8,
                borderRadius: 4,
                backgroundColor: particle.color,
                opacity: progress.interpolate({
                  inputRange: [0, 0.65, 1],
                  outputRange: [0, 1, 0],
                }),
                transform: [
                  {
                    translateX: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, particle.x],
                    }),
                  },
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 0.7, 1],
                      outputRange: [0, particle.y, particle.y + 28],
                    }),
                  },
                  { rotate: particle.rotate },
                  {
                    scale: progress.interpolate({
                      inputRange: [0, 0.2, 1],
                      outputRange: [0.5, 1, 0.8],
                    }),
                  },
                ],
              }}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
}
