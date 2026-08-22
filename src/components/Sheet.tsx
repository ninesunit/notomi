import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeArea } from '@/hooks/useSafeArea';
import { Icon } from '@/components/Icon';
import { SHEET as SHEET_BREAKPOINT } from '@/lib/breakpoints';
import { useVisualViewport } from '@/lib/viewport';
import { feedback } from '@/lib/sound';

/**
 * One container, four presentations.
 *
 * On a phone this is a bottom sheet that slides up from the edge the thumb is
 * already near; on a wide screen it is the centred dialog a mouse expects.
 * Keeping both in one component means every modal in the app gets the native
 * feel without each screen branching on width.
 *
 * The variant says what the sheet is *for*, and the sizing follows from that:
 *
 * - `compact` — a confirmation or a short list of actions.
 * - `auto` — a small informational panel. The default, and what every existing
 *   call site gets, so this addition changes nothing it was not asked to.
 * - `form` — something being typed into. Sized against the *visible* viewport
 *   and padded past the keyboard.
 * - `fullscreen-mobile` — a form with more than a couple of fields, which on a
 *   phone should be a screen rather than a panel with a scroll bar in it.
 *
 * The keyboard is the reason this exists. `useWindowDimensions` reports the
 * layout viewport, and iOS does not shrink that when the keyboard opens — it
 * slides a panel over the bottom. A sheet capped at sixty percent of that
 * number believes it has room it does not have and puts its Save button under
 * the keys, which is why the answer is never "put Save at the bottom".
 */
export type SheetVariant = 'compact' | 'auto' | 'form' | 'fullscreen-mobile';

/** The action that must stay reachable, keyboard or no keyboard. */
export type SheetAction = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
};



export function Sheet({
  visible,
  onClose,
  title,
  icon,
  children,
  footer,
  /** Caps the scrollable body on desktop; the sheet uses a fraction of height. */
  maxHeight = 460,
  variant = 'auto',
  /**
   * Rendered in the header rather than the footer for `form` and
   * `fullscreen-mobile`, where the footer may be behind the keyboard.
   */
  primaryAction,
  /**
   * Whether tapping the scrim closes the sheet.
   *
   * Off for anything holding work that cost something to produce — a scan
   * discarded by a stray tap outside the panel is work the student has to pay
   * for again.
   */
  dismissOnScrim = true,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ComponentProps<typeof Icon>['name'];
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: number;
  variant?: SheetVariant;
  primaryAction?: SheetAction;
  dismissOnScrim?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeArea();
  const viewport = useVisualViewport();
  const sheet = width < SHEET_BREAKPOINT;

  // Only on a phone: a desktop dialog has room, and a desktop keyboard does
  // not cover anything.
  const full = sheet && variant === 'fullscreen-mobile';
  const keyboardAware = sheet && (variant === 'form' || full);

  /*
   * The visible height, not the layout height. `viewport.height` is zero
   * before the first measurement and on anything without visualViewport, and
   * the window is the right answer in both of those cases.
   */
  const visibleHeight = viewport.height || height;
  const bodyMax = full
    ? undefined
    : sheet
      ? Math.max(180, visibleHeight * (variant === 'compact' ? 0.4 : 0.6))
      : variant === 'compact'
        ? Math.min(maxHeight, 280)
        : maxHeight;

  /*
   * The panel itself is already shortened to visualViewport.height. Adding
   * keyboardHeight again would count the keyboard twice and leave a large
   * blank runway below the form. Only the home-indicator inset remains.
   */
  const bodyPadBottom = keyboardAware ? insets.bottom : 0;

  // Header-mounted for keyboard-aware variants; the footer may be covered.
  const actionInHeader = Boolean(primaryAction) && keyboardAware;

  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      slide.setValue(0);
      return;
    }
    if (sheet) feedback('tap', 4);
    Animated.spring(slide, {
      toValue: 1,
      stiffness: 400,
      damping: 25,
      mass: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [visible, slide, sheet]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <Modal
      visible={visible}
      transparent
      // The OS slide would fight the sheet's own animation.
      animationType={sheet ? 'none' : 'fade'}
      onRequestClose={onClose}
    >
      {/*
        The scrim is a SIBLING behind the panel, never an ancestor of it.

        react-native-web renders Pressable as a <button>, and a button treats
        Space and Enter as activation. With the panel nested inside the scrim,
        every space typed into a field bubbled up and dismissed the sheet — you
        could not put a space in a subject's name.
      */}
      <View
        className={`flex-1 ${sheet ? 'justify-end' : 'items-center justify-center px-5'}`}
        // Pinned to what is visible rather than to the window, so a sheet
        // docked to the bottom edge docks to the edge the student can see.
        style={
          keyboardAware && viewport.height
            ? { height: viewport.height, marginTop: viewport.offsetTop }
            : undefined
        }
      >
        <Pressable
          accessibilityRole={dismissOnScrim ? 'button' : 'none'}
          accessibilityLabel={dismissOnScrim ? 'Close' : undefined}
          onPress={dismissOnScrim ? onClose : undefined}
          // Keyboard activation is what caused the bug; the scrim is a
          // pointer target only, and Escape already closes the modal.
          focusable={false}
          style={StyleSheet.absoluteFill}
          className="bg-scrim/40"
        />

        <View
          pointerEvents="box-none"
          className={sheet ? 'w-full' : 'w-full max-w-md'}
          style={sheet ? (full ? { flex: 1 } : undefined) : { maxWidth: 448 }}
        >
          {/* Animated.View carries the transform only. NativeWind does not
              apply className to Animated components, so anything styled with
              utilities has to live on a plain View inside it — the sheet
              rendered with no background at all until this was split. */}
          <Animated.View
            style={
              sheet
                ? full
                  ? { flex: 1, transform: [{ translateY }] }
                  : { transform: [{ translateY }] }
                : undefined
            }
          >
          <View
            className={`overflow-hidden border border-line bg-surface ${
              full ? 'flex-1 rounded-none' : sheet ? 'rounded-t-3xl' : 'rounded-2xl'
            }`}
            style={full ? { paddingTop: insets.top } : undefined}
          >
            {sheet && !full ? (
              // Grab handle: the affordance that says "this drags/dismisses".
              <View className="items-center pb-1 pt-2.5">
                <View className="h-1 w-10 rounded-full bg-line" />
              </View>
            ) : null}

            <View className="flex-row items-center gap-3 border-b border-line px-5 py-4">
              {actionInHeader ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={onClose}
                  hitSlop={8}
                  className="h-9 w-9 items-center justify-center rounded-lg"
                >
                  <Icon name="x" size={16} tone="muted" />
                </Pressable>
              ) : icon ? (
                <View className="h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
                  <Icon name={icon} size={16} tone="accent" />
                </View>
              ) : null}
              <Text className="flex-1 text-[15px] font-semibold text-ink" numberOfLines={1}>
                {title}
              </Text>

              {/*
                Save lives here, not at the bottom.

                A submit button below a scrolling form is the one control the
                keyboard is guaranteed to cover, and on iOS there is no reliable
                way to know it has. In the top-right it is always reachable,
                which is where every native form on the platform puts it.
              */}
              {actionInHeader && primaryAction ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={primaryAction.label}
                  accessibilityState={{ disabled: primaryAction.disabled || primaryAction.loading }}
                  disabled={primaryAction.disabled || primaryAction.loading}
                  onPress={primaryAction.onPress}
                  className={`h-9 items-center justify-center rounded-lg px-3.5 ${
                    primaryAction.disabled || primaryAction.loading ? 'bg-sand' : 'bg-ink'
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      primaryAction.disabled || primaryAction.loading ? 'text-subtle' : 'text-paper'
                    }`}
                  >
                    {primaryAction.loading ? 'Saving…' : primaryAction.label}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  onPress={onClose}
                  hitSlop={8}
                  className="h-9 w-9 items-center justify-center rounded-lg"
                >
                  <Icon name="x" size={16} tone="muted" />
                </Pressable>
              )}
            </View>

            <ScrollView
              style={full ? { flex: 1 } : { maxHeight: bodyMax }}
              contentContainerClassName="gap-4 p-5"
              contentContainerStyle={bodyPadBottom ? { paddingBottom: 20 + bodyPadBottom } : undefined}
              keyboardShouldPersistTaps="handled"
              // Dragging the body puts the keyboard away, which is what a
              // thumb reaching past it is usually trying to do.
              keyboardDismissMode="on-drag"
            >
              {children}
            </ScrollView>

            {footer && !actionInHeader ? (
              <View
                className="flex-row items-center gap-2 border-t border-line px-5 py-4"
                // Clear of the iPhone home indicator when docked to the edge.
                style={{ paddingBottom: sheet ? 16 + insets.bottom : 16 }}
              >
                {footer}
              </View>
            ) : sheet && !full ? (
              <View style={{ height: insets.bottom }} />
            ) : null}
          </View>
          </Animated.View>
        </View>
      </View>
    </Modal>
  );
}

/** True when modals on this viewport should present as bottom sheets. */
export function useIsSheet(): boolean {
  const { width } = useWindowDimensions();
  return width < SHEET_BREAKPOINT;
}
