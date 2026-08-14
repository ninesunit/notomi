import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Animated,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { useAuth } from '@/hooks/useAuth';
import { useSafeArea } from '@/hooks/useSafeArea';
import { feedback } from '@/lib/sound';
import { GlobalSearch } from './GlobalSearch';
import { Logo } from './Logo';
import { DRAWER_SECTIONS, isActive } from './nav';

/**
 * The phone navigation drawer.
 *
 * A bottom bar could not hold this app: nine destinations across a 390pt screen
 * gave 43pt tabs with the last one clipped off the edge. A drawer has no such
 * ceiling — it scrolls, it can group, and it has room for the profile and
 * settings that were previously homeless.
 *
 * Built on PanResponder rather than a gesture library so the edge swipe behaves
 * identically in a browser, in an installed PWA and in a native build.
 */

/** How far in from the left edge a drag has to start to count as an edge swipe. */
const EDGE_WIDTH = 28;
/** Past this fraction of the panel, releasing completes the gesture. */
const COMMIT = 0.4;

function panelWidth(screenWidth: number): number {
  return Math.min(312, Math.round(screenWidth * 0.84));
}

/* ------------------------------------------------------------------ *
 * Edge swipe
 * ------------------------------------------------------------------ */

/**
 * Wraps the page so a rightward drag starting at the left edge opens the drawer.
 *
 * The handler sits on the content wrapper rather than on an invisible strip
 * pinned to the edge: a strip would swallow every tap in its 28 points, and the
 * back chevron on half the screens lives exactly there. Because this uses the
 * bubbling `onMoveShouldSetPanResponder`, a ScrollView that has already claimed
 * the touch keeps it, so vertical scrolling is untouched.
 */
export function EdgeSwipeArea({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: ReactNode;
}) {
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (event, gesture) => {
        // pageX is where the finger is now; subtracting dx gives where it began.
        const startedAt = event.nativeEvent.pageX - gesture.dx;
        if (startedAt > EDGE_WIDTH) return false;
        return gesture.dx > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.6;
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx > 40) onOpen();
      },
    })
  ).current;

  return (
    <View className="flex-1 min-h-0" {...responder.panHandlers}>
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Top bar
 * ------------------------------------------------------------------ */

export function MobileTopBar({
  onMenu,
  onAsk,
  onHide,
}: {
  onMenu: () => void;
  onAsk: () => void;
  onHide: () => void;
}) {
  const insets = useSafeArea();
  const { width } = useWindowDimensions();

  return (
    <View
      className="border-b border-line bg-sand"
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View className="flex-row items-center gap-2 px-3 py-2.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          onPress={() => {
            feedback('tap');
            onMenu();
          }}
          hitSlop={8}
          className="h-10 w-10 items-center justify-center rounded-xl"
        >
          <Icon name="menu" size={20} color="#1B1A17" />
        </Pressable>

        <Logo size={26} />

        <View className="flex-1">
          <GlobalSearch />
        </View>

        {width >= 640 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hide navigation"
            onPress={() => {
              feedback('tap');
              onHide();
            }}
            hitSlop={8}
            className="h-10 w-10 items-center justify-center rounded-xl"
          >
            <Icon name="panel-left-close" size={18} color="#6F6A5F" />
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask Notomi"
          onPress={() => {
            feedback('tap');
            onAsk();
          }}
          hitSlop={8}
          className="h-10 w-10 items-center justify-center rounded-xl bg-ink"
        >
          <Icon name="zap" size={17} color="#F7F5EE" />
        </Pressable>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * The drawer itself
 * ------------------------------------------------------------------ */

export function NavDrawer({
  open,
  onClose,
  pathname,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeArea();
  const { user, logOut } = useAuth();

  const size = panelWidth(width);
  const progress = useRef(new Animated.Value(0)).current;
  /**
   * Kept mounted for one animation after closing. Unmounting immediately would
   * make the panel vanish instead of sliding out.
   */
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);

    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: open ? 240 : 190,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });

    return () => animation.stop();
  }, [open, progress]);

  /** Drag the open panel leftwards to dismiss it. */
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
      onPanResponderMove: (_event, gesture) => {
        const fraction = Math.max(0, Math.min(1, 1 + gesture.dx / size));
        progress.setValue(fraction);
      },
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx < -size * COMMIT) onClose();
        else {
          Animated.spring(progress, {
            toValue: 1,
            speed: 30,
            bounciness: 0,
            useNativeDriver: Platform.OS !== 'web',
          }).start();
        }
      },
    })
  ).current;

  if (!mounted) return null;

  const displayName = user?.displayName || (user?.isAnonymous ? 'Guest' : user?.email) || 'You';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: progress }]}
        pointerEvents={open ? 'auto' : 'none'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={onClose}
          focusable={false}
          style={StyleSheet.absoluteFill}
          className="bg-ink/40"
        />
      </Animated.View>

      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: size,
          transform: [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-size, 0],
              }),
            },
          ],
        }}
        {...responder.panHandlers}
      >
        {/* The transform stays on the Animated.View and the utilities on a
            plain View inside it — NativeWind does not apply className to an
            Animated.View, and a styled one renders with no background. */}
        <View
          className="h-full w-full border-r border-line bg-sand"
          // calc(0.75rem + safe-area-inset-bottom), in the units RN speaks:
          // the home indicator overlaps the last row otherwise.
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 12 }}
        >
          <View className="flex-row items-center gap-2.5 px-5 pb-3 pt-4">
            <Logo size={30} />
            <Text className="flex-1 text-lg font-bold tracking-tight text-ink">Notomi</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close menu"
              onPress={onClose}
              hitSlop={8}
              className="h-9 w-9 items-center justify-center rounded-lg"
            >
              <Icon name="x" size={18} color="#6F6A5F" />
            </Pressable>
          </View>

          <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-5 px-3 pb-4">
            {DRAWER_SECTIONS.map((section) => (
              <View key={section.title} className="gap-1">
                <Text className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-subtle">
                  {section.title}
                </Text>
                {section.items.map((item) => (
                  <DrawerLink
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    active={isActive(pathname, item.href, item.legacyPaths)}
                  />
                ))}
              </View>
            ))}
          </ScrollView>

          <View className="shrink-0 gap-1 border-t border-line px-3 pt-3">
            <Link href="/profile" asChild>
            <Pressable accessibilityRole="link" className="flex-row items-center gap-3 rounded-xl px-3 py-2">
              <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-soft">
                <Text className="text-sm font-bold text-accent">{initial}</Text>
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {displayName}
                </Text>
                <Text className="text-xs text-subtle" numberOfLines={1}>
                  {user?.isAnonymous ? 'Guest account' : (user?.email ?? '')}
                </Text>
              </View>
              <Icon name="chevron-right" size={15} color="#9A9488" />
            </Pressable>
            </Link>

            <DrawerLink
              href="/settings"
              label="Settings"
              icon="settings"
              active={isActive(pathname, '/settings')}
            />

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void logOut().catch((error) =>
                  Alert.alert(
                    'Could not sign out',
                    error instanceof Error ? error.message : 'Try again.'
                  )
                );
              }}
              className="flex-row items-center gap-3 rounded-xl px-3 py-3"
            >
              <Icon name="log-out" size={16} color="#6F6A5F" />
              <Text className="text-[15px] font-medium text-muted">Sign out</Text>
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

function DrawerLink({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  active: boolean;
}) {
  return (
    <Link href={href} asChild>
      {/* No onPress here: expo-router owns it through `asChild`, and the
          drawer closes on the pathname change instead. */}
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        onPressIn={() => feedback('tap', 6)}
        className={`flex-row items-center gap-3 rounded-xl px-3 py-3 ${
          active ? 'bg-ink' : ''
        }`}
      >
        <Icon name={icon} size={17} color={active ? '#FFFFFF' : '#6F6A5F'} />
        <Text
          className={`text-[15px] ${active ? 'font-semibold text-white' : 'font-medium text-muted'}`}
        >
          {label}
        </Text>
      </Pressable>
    </Link>
  );
}
