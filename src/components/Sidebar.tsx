import { useRef, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Link, usePathname } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { feedback, isSoundEnabled, play, setSoundEnabled } from '@/lib/sound';
import { useAuth } from '@/hooks/useAuth';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { isActive, NAV_ITEMS, TAB_ITEMS } from './nav';

/**
 * Fixed-width, full-height rail. It must never grow or shrink with content —
 * the workspace layout depends on it holding exactly w-64 so the main pane can
 * own the remaining width.
 */
export function Sidebar() {
  const pathname = usePathname();
  const { user, logOut } = useAuth();
  const [sound, setSound] = useState(isSoundEnabled);

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <View className="h-full w-64 shrink-0 border-r border-line bg-sand">
      <View className="min-h-0 flex-1 justify-between p-4">
        {/* min-h-0 + a scroller: the shell clips overflow, so on a short
            viewport the nav has to scroll rather than lose its last items. */}
        <View className="min-h-0 flex-1 gap-4">
          <Link href="/" asChild>
            <Pressable className="flex-row items-center gap-2.5 px-2 py-1">
              <Logo size={30} />
              <Text className="text-lg font-bold tracking-tight text-ink">Notomi</Text>
            </Pressable>
          </Link>

          <GlobalSearch />

          <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-1 pb-2">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link key={item.href} href={item.href} asChild>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityState={{ selected: active }}
                    className={`flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${
                      active ? 'bg-surface' : ''
                    }`}
                  >
                    <Feather
                      name={item.icon}
                      size={16}
                      color={active ? '#B4552D' : '#6F6A5F'}
                    />
                    <Text
                      className={`text-[15px] ${
                        active ? 'font-semibold text-ink' : 'font-medium text-muted'
                      }`}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                </Link>
              );
            })}
          </ScrollView>
        </View>

        <View className="shrink-0 gap-2 border-t border-line pt-4">
          <View className="flex-row items-center gap-2.5 px-2">
            <View className="h-8 w-8 items-center justify-center rounded-full bg-accent-soft">
              <Text className="text-xs font-bold text-accent">{initial}</Text>
            </View>
            <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
              {displayName}
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: sound }}
            accessibilityLabel={sound ? 'Turn sound off' : 'Turn sound on'}
            onPress={() => {
              const next = !sound;
              setSoundEnabled(next);
              setSound(next);
              // Play after enabling so the toggle confirms itself audibly.
              if (next) play('toggle');
            }}
            className="flex-row items-center gap-3 rounded-xl px-3 py-2"
          >
            <Feather name={sound ? 'volume-2' : 'volume-x'} size={15} color="#6F6A5F" />
            <Text className="text-sm font-medium text-muted">
              {sound ? 'Sound on' : 'Sound off'}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => void logOut()}
            className="flex-row items-center gap-3 rounded-xl px-3 py-2"
          >
            <Feather name="log-out" size={15} color="#6F6A5F" />
            <Text className="text-sm font-medium text-muted">Sign out</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * Compact bottom bar used instead of the rail on phone-width viewports.
 *
 * The selected tab gets a filled pill behind its icon and a spring under the
 * finger — the two details that separate a native tab bar from a row of links.
 */
export function BottomTabs() {
  const pathname = usePathname();

  return (
    <View className="w-full shrink-0 flex-row border-t border-line bg-sand pb-1">
      {TAB_ITEMS.map((item) => (
        <BottomTab key={item.href} item={item} active={isActive(pathname, item.href)} />
      ))}
    </View>
  );
}

function BottomTab({
  item,
  active,
}: {
  item: (typeof TAB_ITEMS)[number];
  active: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      speed: 50,
      bounciness: 0,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

  return (
    <Link href={item.href} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        // The cue rides on press-in, not press: expo-router owns onPress here
        // through `asChild`, and setting our own would race with navigation.
        onPressIn={() => {
          feedback('tap', 6);
          spring(0.92);
        }}
        onPressOut={() => spring(1)}
        className="flex-1 items-center py-1.5"
      >
        {/* The transform lives on the Animated.View and the utilities on a
            plain View inside it: NativeWind does not apply className to an
            Animated.View, so a styled one renders unstyled. */}
        <Animated.View style={{ transform: [{ scale }] }}>
          <View className="items-center gap-1">
            <View
              className={`h-7 w-12 items-center justify-center rounded-full ${
                active ? 'bg-accent-soft' : ''
              }`}
            >
              <Feather name={item.icon} size={18} color={active ? '#B4552D' : '#6F6A5F'} />
            </View>
            <Text
              className={`text-[11px] ${
                active ? 'font-semibold text-accent' : 'font-medium text-muted'
              }`}
            >
              {item.shortLabel}
            </Text>
          </View>
        </Animated.View>
      </Pressable>
    </Link>
  );
}
