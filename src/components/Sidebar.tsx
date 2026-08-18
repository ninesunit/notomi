import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { Link, usePathname } from 'expo-router';
import { Icon } from '@/components/Icon';
import { isSoundEnabled, play, setSoundEnabled } from '@/lib/sound';
import { useAuth } from '@/hooks/useAuth';
import { useSafeArea } from '@/hooks/useSafeArea';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { isActive, NAV_ITEMS, SETTINGS_ITEM } from './nav';
import { Touchable } from '@/components/ui';

/**
 * Fixed-width, full-height rail. It must never grow or shrink with content —
 * the workspace layout depends on it holding exactly w-64 so the main pane can
 * own the remaining width.
 */
export function Sidebar({ onAsk, onCollapse }: { onAsk: () => void; onCollapse: () => void }) {
  const pathname = usePathname();
  const { user, logOut } = useAuth();
  const insets = useSafeArea();
  const [sound, setSound] = useState(isSoundEnabled);

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <View
      className="h-full w-64 shrink-0 border-r border-line bg-sand"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left }}
    >
      {/* A column: the nav scrolls, the profile block never does. */}
      <View className="min-h-0 flex-1 justify-between p-4">
        {/* min-h-0 + a scroller: the shell clips overflow, so on a short
            viewport the nav has to scroll rather than lose its last items. */}
        <View className="min-h-0 flex-1 gap-4">
          <View className="flex-row items-center gap-1">
            <Link href="/dashboard" asChild>
              <Touchable className="min-w-0 flex-1 flex-row items-center gap-2.5 px-2 py-1">
                <Logo size={30} />
                <Text className="text-lg font-bold tracking-tight text-ink">Notomi</Text>
              </Touchable>
            </Link>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Hide sidebar"
              onPress={onCollapse}
              hitSlop={8}
              className="h-9 w-9 items-center justify-center rounded-lg"
            >
              <Icon name="panel-left-close" size={17} color="#6F6A5F" />
            </Touchable>
          </View>

          <GlobalSearch />

          <Touchable
            accessibilityRole="button"
            accessibilityLabel="Ask Notomi"
            onPress={onAsk}
            className="flex-row items-center gap-2.5 rounded-xl bg-ink px-3 py-2.5"
          >
            <Icon name="zap" size={15} color="#F7F5EE" />
            <Text className="text-[15px] font-semibold text-paper">Ask Notomi</Text>
          </Touchable>

          <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-1 pb-2">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href, item.legacyPaths);
              return (
                <Link key={item.href} href={item.href} asChild>
                  <Touchable
                    accessibilityRole="link"
                    accessibilityState={{ selected: active }}
                    className={`flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${
                      active ? 'bg-ink' : ''
                    }`}
                  >
                    <Icon
                      name={item.icon}
                      size={16}
                      color={active ? '#FFFFFF' : '#6F6A5F'}
                    />
                    <Text
                      className={`text-[15px] ${
                        active ? 'font-semibold text-white' : 'font-medium text-muted'
                      }`}
                    >
                      {item.label}
                    </Text>
                  </Touchable>
                </Link>
              );
            })}
          </ScrollView>
        </View>

        <View className="shrink-0 gap-2 border-t border-line pt-4">
          <Link href="/profile" asChild>
            <Touchable
              accessibilityRole="link"
              accessibilityLabel="Open your profile"
              className="flex-row items-center gap-2.5 rounded-xl px-2 py-1.5"
            >
              <View className="h-8 w-8 items-center justify-center rounded-full bg-accent-soft">
                <Text className="text-xs font-bold text-accent">{initial}</Text>
              </View>
              <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={1}>
                {displayName}
              </Text>
              <Icon name="chevron-right" size={14} color="#9A9488" />
            </Touchable>
          </Link>
          <Link href={SETTINGS_ITEM.href} asChild>
            <Touchable
              accessibilityRole="link"
              accessibilityState={{ selected: isActive(pathname, SETTINGS_ITEM.href) }}
              className={`flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${
                isActive(pathname, SETTINGS_ITEM.href) ? 'bg-ink' : ''
              }`}
            >
              <Icon
                name={SETTINGS_ITEM.icon}
                size={15}
                color={isActive(pathname, SETTINGS_ITEM.href) ? '#FFFFFF' : '#6F6A5F'}
              />
              <Text
                className={`text-sm font-medium ${
                  isActive(pathname, SETTINGS_ITEM.href) ? 'text-white' : 'text-muted'
                }`}
              >
                Settings
              </Text>
            </Touchable>
          </Link>
          <Touchable
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
            <Icon name={sound ? 'volume-2' : 'volume-x'} size={15} color="#6F6A5F" />
            <Text className="text-sm font-medium text-muted">
              {sound ? 'Sound on' : 'Sound off'}
            </Text>
          </Touchable>

          <Touchable
            accessibilityRole="button"
            onPress={() => {
              void logOut().catch((error) =>
                Alert.alert(
                  'Could not sign out',
                  error instanceof Error ? error.message : 'Try again.'
                )
              );
            }}
            className="flex-row items-center gap-3 rounded-xl px-3 py-2"
          >
            <Icon name="log-out" size={15} color="#6F6A5F" />
            <Text className="text-sm font-medium text-muted">Sign out</Text>
          </Touchable>
        </View>
      </View>
    </View>
  );
}
