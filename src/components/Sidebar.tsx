import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link, usePathname } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { isSoundEnabled, play, setSoundEnabled } from '@/lib/sound';
import { useAuth } from '@/hooks/useAuth';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { isActive, NAV_ITEMS } from './nav';

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
