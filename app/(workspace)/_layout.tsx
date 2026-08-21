import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { router, Slot, usePathname } from 'expo-router';
import { getDocs } from 'firebase/firestore';
import { lazyScreen } from '@/components/lazyScreen';
import { EdgeSwipeArea, MobileTopBar, NavDrawer } from '@/components/Drawer';
import { IngestBanner } from '@/components/IngestBanner';
import { resumeDrive, setDriveIdentity } from '@/lib/driveUtils';
import { useSafeArea } from '@/hooks/useSafeArea';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { IngestProvider } from '@/hooks/useIngest';
import { ReminderProvider } from '@/hooks/useReminders';
import { UndoProvider } from '@/hooks/useUndo';
import { useWorkspaceChrome, WorkspaceChromeProvider } from '@/hooks/useWorkspaceChrome';
import { Icon, useTones } from '@/components/Icon';
import { isActive, isDetailRoute, NAV_ITEMS, SETTINGS_ITEM } from '@/components/nav';

/**
 * Mounted in the shell, so it would otherwise sit in the first bundle of every
 * cold load — including the ones where nobody asks it anything. Rendered only
 * once opened, because a lazy component that is always rendered fetches its
 * chunk immediately and saves nothing.
 */
const Copilot = lazyScreen<{ visible: boolean; onClose: () => void }>(
  () => import('@/components/Copilot'),
  'Copilot',
  'Waking up…'
);
import { paths } from '@/lib/paths';
import type { ClassBlock } from '@/lib/schema';
import { getDb, getFirebaseAuth } from '@/services/firebase';
import { canSharePresence, setPresence } from '@/services/social';

/** Below this the rail becomes a swipeable drawer (iPhone portrait, split-view iPad). */
export const RAIL_BREAKPOINT = 900;

/**
 * The shell's height, in the one unit that means "what you can actually see".
 * Cast because React Native's style types know nothing of CSS units; on native
 * this is simply not applied and flex does the work.
 */
const VIEWPORT =
  Platform.OS === 'web'
    ? ({ height: '100dvh', maxHeight: '100dvh', overflow: 'hidden' } as unknown as ViewStyle)
    : undefined;

/**
 * Workspace shell.
 *
 * The grey block that used to escape below "Your subjects" was a height-chain
 * problem, not a colour problem: the shell never established a bounded height,
 * so `h-full` on the sidebar resolved against an auto-height parent and the
 * sand-coloured rail painted past the viewport instead of scrolling inside it.
 *
 * Three things keep it contained now:
 *   1. html / body / #root are pinned to 100dvh in global.css with the document
 *      scrollport switched off, giving the percentage chain something real —
 *      and something *visible* — to resolve against.
 *   2. This root is a bounded row/column of exactly that height. It must never
 *      carry min-h-screen: 100vh is the large viewport on iOS, taller than what
 *      is on screen, which is what pushed the drawer's Sign out under the home
 *      indicator and made the whole page rubber-band.
 *   3. The main pane is `flex-1 min-w-0 h-full overflow-hidden`, so overflow is
 *      clipped here and scrolling happens inside each screen's own scroller
 *      (see ScreenScroll) rather than spilling out of the shell.
 *
 * There are no absolutely positioned backgrounds anywhere in the tree; every
 * surface colour is painted by an in-flow View that owns its own box.
 */
export default function WorkspaceLayout() {
  return (
    <WorkspaceChromeProvider>
      <WorkspaceShell />
    </WorkspaceChromeProvider>
  );
}

function WorkspaceShell() {
  const tones = useTones();
  const { width } = useWindowDimensions();
  const insets = useSafeArea();
  const { user } = useAuth();
  const uid = user?.uid ?? '';
  const pathname = usePathname();
  const showRail = width >= RAIL_BREAKPOINT;
  const chrome = useWorkspaceChrome();
  const chromeProgress = useRef(new Animated.Value(chrome.hidden ? 0 : 1)).current;

  const [drawer, setDrawer] = useState(false);
  const [asking, setAsking] = useState(false);
  const [classBlocks, setClassBlocks] = useState<ClassBlock[]>([]);
  const [sharePresence, setSharePresence] = useState(false);

  useEffect(() => {
    if (!uid) return;
    let active = true;
    void Promise.all([
      canSharePresence(uid),
      getDocs(paths.classes(getDb(), uid)),
    ]).then(([allowed, snapshot]) => {
      if (!active) return;
      setSharePresence(allowed);
      setClassBlocks(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ClassBlock));
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [uid]);

  useEffect(() => {
    if (!uid || !sharePresence || pathname.startsWith('/tasks')) return;
    const publishCurrentClass = () => {
      const now = new Date();
      const day = (now.getDay() + 6) % 7;
      const minute = now.getHours() * 60 + now.getMinutes();
      const activeClass = classBlocks.find(
        (block) => block.day === day && block.startMinute <= minute && block.endMinute > minute
      );
      if (!activeClass) return;
      void setPresence(uid, {
        status: 'class',
        subjectName: activeClass.subjectName || activeClass.title,
        minutes: Math.max(2, activeClass.endMinute - minute),
      }).catch(() => undefined);
    };
    publishCurrentClass();
    const timer = setInterval(publishCurrentClass, 60_000);
    return () => clearInterval(timer);
  }, [uid, sharePresence, classBlocks, pathname]);

  /**
   * Navigating closes the drawer.
   *
   * Doing it here rather than in each row's onPress matters: `<Link asChild>`
   * injects its own onPress, and a handler of ours in that slot would replace
   * expo-router's and stop the link navigating at all.
   */
  useEffect(() => setDrawer(false), [pathname]);

  /*
   * Which of the five surfaces is on screen, for the header to say so.
   *
   * Derived from the nav rather than kept per screen, because a title held in
   * thirty-odd components is thirty-odd chances for one to disagree with the
   * drawer about where the student is.
   */
  const currentSurface =
    NAV_ITEMS.find((item) => isActive(pathname, item.href, item.legacyPaths))?.shortLabel ??
    (isActive(pathname, SETTINGS_ITEM.href) ? SETTINGS_ITEM.shortLabel : undefined);

  /**
   * A student who linked Drive should not be asked again on every reload.
   *
   * The identity has to be handed over first: a grant held by the Worker is
   * keyed by the signed-in account, so resuming means proving who is asking.
   * Where no grant exists this falls back to Google's silent reissue, and
   * where that fails too it stays quiet rather than showing an error nobody
   * asked for.
   */
  useEffect(() => {
    setDriveIdentity(async () => {
      const current = getFirebaseAuth().currentUser;
      if (!current) throw new Error('Not signed in.');
      return current.getIdToken();
    });
    void resumeDrive();
  }, []);

  // The rail and the drawer are the same navigation in two shapes; only one can
  // be on screen, so a resize past the breakpoint has to dismiss the drawer.
  useEffect(() => {
    if (showRail) setDrawer(false);
  }, [showRail]);

  useEffect(() => {
    const animation = Animated.timing(chromeProgress, {
      toValue: chrome.hidden ? 0 : 1,
      duration: chrome.hidden ? 190 : 240,
      easing: chrome.hidden ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [chrome.hidden, chromeProgress]);

  // Belt-and-braces against a deep link rendering a screen that calls useUid()
  // before the gate in app/_layout.tsx has settled.
  if (!user) {
    return (
      <View className="h-full w-full items-center justify-center bg-paper">
        <ActivityIndicator color={tones.accent} />
      </View>
    );
  }

  return (
    <IngestProvider>
      <UndoProvider>
        <ReminderProvider>
          {/* No padding on the root: the top bar carries the inset itself so
              its own background fills the notch area, rather than leaving a
              bare strip of paper above a floating bar. */}
          <View
            className={`relative w-full h-full bg-paper ${showRail ? 'flex-row' : 'flex-col'}`}
            style={VIEWPORT}
          >
            {showRail ? (
              <Animated.View
                pointerEvents={chrome.hidden ? 'none' : 'auto'}
                accessibilityElementsHidden={chrome.hidden}
                importantForAccessibility={chrome.hidden ? 'no-hide-descendants' : 'auto'}
                style={{
                  width: chromeProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 256] }),
                  height: '100%',
                  opacity: chromeProgress,
                  overflow: 'hidden',
                }}
              >
                <Sidebar onAsk={() => setAsking(true)} onCollapse={() => chrome.setHidden(true)} />
              </Animated.View>
            ) : null}

            <View
              className={`flex-1 min-w-0 h-full bg-paper ${
                Platform.OS === 'web' ? 'overflow-hidden' : ''
              }`}
              style={showRail ? { paddingRight: insets.right } : undefined}
            >
              {showRail ? null : (
                <Animated.View
                  pointerEvents={chrome.hidden ? 'none' : 'auto'}
                  accessibilityElementsHidden={chrome.hidden}
                  importantForAccessibility={chrome.hidden ? 'no-hide-descendants' : 'auto'}
                  style={{
                    maxHeight: chromeProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 160] }),
                    opacity: chromeProgress,
                    overflow: 'hidden',
                  }}
                >
                  <MobileTopBar
                    onMenu={() => setDrawer(true)}
                    onAsk={() => setAsking(true)}
                    onHide={() => chrome.setHidden(true)}
                    title={currentSurface}
                  />
                </Animated.View>
              )}

              <IngestBanner />

              {/* min-h-0 lets this shrink below its content so the banner is
                  never pushed off-screen and the scroller keeps its bounds. */}
              {showRail ? (
                <View className="flex-1 min-h-0">
                  <Slot />
                </View>
              ) : (
                <EdgeSwipeArea
                  onOpen={() => setDrawer(true)}
                  // Only on a screen that was navigated into, and only when
                  // there is something to pop: a deep link opened cold has no
                  // history, and a gesture that silently does nothing is worse
                  // than one that opens the drawer.
                  onBack={
                    isDetailRoute(pathname) && router.canGoBack()
                      ? () => router.back()
                      : undefined
                  }
                >
                  <Slot />
                </EdgeSwipeArea>
              )}
            </View>

            {chrome.hidden && !pathname.startsWith('/knowledge/notes/') ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show navigation"
                onPress={() => chrome.setHidden(false)}
                className="absolute z-50 h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface shadow"
                style={{ top: insets.top + 12, left: insets.left + 12 }}
              >
                <Icon name="panel-left-open" size={19} tone="ink" />
              </Pressable>
            ) : null}

            {showRail ? null : (
              <NavDrawer open={drawer} onClose={() => setDrawer(false)} pathname={pathname} />
            )}

            {asking ? <Copilot visible onClose={() => setAsking(false)} /> : null}
          </View>
        </ReminderProvider>
      </UndoProvider>
    </IngestProvider>
  );
}
