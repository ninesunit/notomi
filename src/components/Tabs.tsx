import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
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
 * piece of motion that makes a web tab bar read as a native one. Phone layouts
 * use equal-width icon buttons, while labels and counts return from `sm` up.
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
      stiffness: 400,
      damping: 25,
      mass: 1,
      useNativeDriver: false,
    };
    Animated.parallel([
      Animated.spring(x, { toValue: frame.x, ...config }),
      Animated.spring(width, { toValue: frame.width, ...config }),
    ]).start();
  };

  useEffect(() => {
    settle(index);
    // settle reads a ref that layout fills in; re-running on index is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, tabs.length]);

  return (
    <View className="mb-6 w-full items-center overflow-hidden sm:items-start">
      <View className="flex-row self-center rounded-2xl border border-line bg-sand p-1 sm:self-start">
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
              // Icon-only below `sm`, so the name has to come from here rather
              // than from the text beside it.
              accessibilityLabel={
                tab.count === undefined ? tab.label : `${tab.label}, ${tab.count}`
              }
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
              className="h-11 w-11 flex-row items-center justify-center rounded-xl sm:h-auto sm:w-auto sm:px-3.5 sm:py-2.5"
            >
              <Icon name={tab.icon} size={14} tone={active ? 'accent' : 'muted'} />
              <Text
                className={`hidden text-[13px] sm:ml-2 sm:inline ${
                  active ? 'font-semibold text-ink' : 'font-medium text-muted'
                }`}
              >
                {tab.label}
              </Text>
              {tab.count ? (
                <View
                  className={`hidden min-w-[18px] items-center rounded-full px-1.5 py-0.5 sm:ml-2 sm:flex ${
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
    </View>
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
