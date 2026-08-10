import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { feedback } from '@/lib/sound';
import type { IconName } from './ui';

export type Tab<T extends string> = {
  id: T;
  label: string;
  icon: IconName;
  /** Small count shown after the label. Hidden when zero or undefined. */
  count?: number;
};

/**
 * The segmented control used inside a subject.
 *
 * The selected pill slides between tabs rather than cutting, which is the one
 * piece of motion that makes a web tab bar read as a native one. It scrolls
 * horizontally so a fifth tab never squeezes the others into initials.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value)
  );

  // Each tab reports its own frame, so the pill can move to a real position
  // rather than an assumed equal share of the width.
  const frames = useRef<{ x: number; width: number }[]>([]);
  const x = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(0)).current;

  const settle = (target: number) => {
    const frame = frames.current[target];
    if (!frame) return;
    const config = {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    };
    Animated.parallel([
      Animated.timing(x, { toValue: frame.x, ...config }),
      Animated.timing(width, { toValue: frame.width, ...config }),
    ]).start();
  };

  useEffect(() => {
    settle(index);
    // settle reads a ref that layout fills in; re-running on index is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, tabs.length]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="mb-6"
      contentContainerStyle={{ paddingRight: 8 }}
    >
      <View className="flex-row rounded-2xl border border-line bg-sand p-1">
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: x,
            width,
          }}
        >
          <View className="h-full w-full rounded-xl border border-line bg-surface" />
        </Animated.View>

        {tabs.map((tab, position) => {
          const active = tab.id === value;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onLayout={(event) => {
                const { x: left, width: measured } = event.nativeEvent.layout;
                frames.current[position] = { x: left + 4, width: measured };
                if (position === index) {
                  // First layout: place the pill without animating it in from 0.
                  x.setValue(left + 4);
                  width.setValue(measured);
                }
              }}
              onPress={() => {
                if (active) return;
                feedback('toggle');
                onChange(tab.id);
              }}
              className="flex-row items-center gap-2 rounded-xl px-3.5 py-2.5"
            >
              <Feather name={tab.icon} size={14} color={active ? '#B4552D' : '#6F6A5F'} />
              <Text
                className={`text-[13px] ${
                  active ? 'font-semibold text-ink' : 'font-medium text-muted'
                }`}
              >
                {tab.label}
              </Text>
              {tab.count ? (
                <View
                  className={`min-w-[18px] items-center rounded-full px-1.5 py-0.5 ${
                    active ? 'bg-accent-soft' : 'bg-line/60'
                  }`}
                >
                  <Text
                    className={`text-[10px] font-bold ${active ? 'text-accent' : 'text-muted'}`}
                  >
                    {tab.count}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

/**
 * Cross-fades between tab bodies.
 *
 * Mounting the new panel with a fade rather than swapping it instantly is what
 * stops a tab change from feeling like a page load. The key forces a remount so
 * the animation restarts for each panel.
 */
export function TabPanel({ id, children }: { id: string; children: React.ReactNode }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [id, progress]);

  return (
    <Animated.View
      style={{
        opacity: progress,
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
