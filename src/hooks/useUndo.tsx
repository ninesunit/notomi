import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { useSafeArea } from '@/hooks/useSafeArea';
import { Feather } from '@expo/vector-icons';

/**
 * Deferred destructive actions with an undo window.
 *
 * The row disappears immediately — that is what makes a swipe feel native —
 * but the Firestore delete does not run until the toast expires. Undo simply
 * cancels the pending timer, so nothing has to be reconstructed and no write
 * is wasted. If the app is closed inside the window, the commit runs on
 * unmount rather than being silently dropped.
 */

const UNDO_MS = 5000;

type Pending = {
  /** The domain id of the record being removed — what lists filter on. */
  key: string;
  label: string;
  commit: () => Promise<unknown>;
  onUndo?: () => void;
};

type UndoValue = {
  /** Hides the record locally, then commits unless undone. */
  schedule: (entry: Pending) => void;
  /** Keys currently pending deletion, so lists can filter them out. */
  hidden: Set<string>;
};

const UndoContext = createContext<UndoValue | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref as well as state so unmount can flush without a stale closure.
  const inFlight = useRef<Pending | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const finish = useCallback((entry: Pending) => {
    clearTimer();
    inFlight.current = null;
    setPending(null);
    // Committed: the record will disappear from the snapshot on its own, so the
    // local filter has done its job and can release the key.
    void entry
      .commit()
      .catch(() => undefined)
      .finally(() => {
        setHidden((previous) => {
          const next = new Set(previous);
          next.delete(entry.key);
          return next;
        });
      });
  }, []);

  const schedule = useCallback(
    (entry: Pending) => {
      // Only one pending action at a time: a second swipe commits the first
      // rather than losing it.
      if (inFlight.current) finish(inFlight.current);

      inFlight.current = entry;
      setPending(entry);
      setHidden((previous) => new Set(previous).add(entry.key));

      timer.current = setTimeout(() => finish(entry), UNDO_MS);
    },
    [finish]
  );

  const undo = useCallback(() => {
    const entry = inFlight.current;
    if (!entry) return;

    clearTimer();
    inFlight.current = null;
    setPending(null);
    setHidden((previous) => {
      const next = new Set(previous);
      next.delete(entry.key);
      return next;
    });
    entry.onUndo?.();
  }, []);

  // A pending delete must not vanish because the student navigated away.
  useEffect(() => {
    return () => {
      clearTimer();
      if (inFlight.current) void inFlight.current.commit().catch(() => undefined);
    };
  }, []);

  const value = useMemo<UndoValue>(() => ({ schedule, hidden }), [schedule, hidden]);

  return (
    <UndoContext.Provider value={value}>
      {children}
      {pending ? <UndoToast label={pending.label} onUndo={undo} /> : null}
    </UndoContext.Provider>
  );
}

export function useUndo(): UndoValue {
  const context = useContext(UndoContext);
  if (!context) throw new Error('useUndo must be used inside <UndoProvider>');
  return context;
}

function UndoToast({ label, onUndo }: { label: string; onUndo: () => void }) {
  const insets = useSafeArea();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [rise]);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        // Clear of the bottom tab bar as well as the home indicator.
        bottom: insets.bottom + 76,
        opacity: rise,
        transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        alignItems: 'center',
        paddingHorizontal: 20,
      }}
    >
      {/* Inline styles above, utilities below: NativeWind does not apply
          className to Animated components. */}
      <View className="w-full max-w-sm flex-row items-center gap-3 rounded-xl bg-ink px-4 py-3">
        <Feather name="trash-2" size={14} color="#F7F5EE" />
        <Text className="flex-1 text-[13px] text-paper" numberOfLines={1}>
          {label}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Undo" onPress={onUndo} hitSlop={8}>
          <Text className="text-[13px] font-bold text-accent">Undo</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
