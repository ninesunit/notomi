import { forwardRef, useRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Icon, type IconName, useTones } from '@/components/Icon';
import { feedback } from '@/lib/sound';

/* ---------------------------- Touchable ---------------------------- */

type TouchableProps = Omit<PressableProps, 'children' | 'style'> & {
  children: ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * How far it sinks. Cards want less than buttons — the same 3% on a
   * full-width card reads as the whole screen lurching.
   */
  scaleTo?: number;
  /** Pass 'none' for targets that fire repeatedly, like a stepper. */
  cue?: 'tap' | 'toggle' | 'none';
};

/**
 * A Pressable that answers back.
 *
 * `Button` has sunk slightly under the finger since it was written, but most
 * of what a student actually taps is not a Button — it is a subject card, a
 * timetable block, a to-do row, a tab. Those were bare Pressables, and because
 * the app clears `-webkit-tap-highlight-color` to avoid iOS's grey flash, they
 * had no feedback at all: on a phone the tap landed, a screen changed a moment
 * later, and nothing in between said the touch had registered. That gap is
 * most of the difference between "an app" and "a website in a browser".
 *
 * Every unrecognised prop is forwarded rather than picked off a whitelist,
 * because the most common use of this is inside `<Link asChild>`, and Link
 * clones its child with the href and press handler that make the link work. A
 * typed subset would drop them and turn every card into a dead rectangle —
 * quietly, since it would still look and animate exactly right.
 */
export const Touchable = forwardRef<View, TouchableProps>(function Touchable(
  {
    children,
    onPress,
    onPressIn,
    onPressOut,
    disabled = false,
    className = '',
    style,
    scaleTo = 0.98,
    cue = 'tap',
    ...rest
  },
  ref
) {
  const scale = useRef(new Animated.Value(1)).current;

  // useNativeDriver is false on web: react-native-web has no native animation
  // thread, and asking for one there warns on every press.
  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      speed: 40,
      bounciness: 0,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

  return (
    <Pressable
      {...rest}
      ref={ref}
      disabled={disabled}
      // The caller's own handlers still run; the animation is added to them
      // rather than replacing them.
      onPressIn={(event) => {
        if (!disabled) spring(scaleTo);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        spring(1);
        onPressOut?.(event);
      }}
      onPress={
        onPress
          ? (event) => {
              if (cue !== 'none') feedback(cue);
              onPress(event);
            }
          : undefined
      }
      className={className}
      style={[{ transform: [{ scale }] }, style]}
    >
      {children}
    </Pressable>
  );
});

/* ----------------------------- Button ----------------------------- */

type ButtonProps = {
  label: string;
  /**
   * The press event is part of the signature even though most callers ignore
   * it: `<Link asChild><Button/></Link>` injects expo-router's own handler
   * here, and that handler reads the event to decide whether to navigate.
   * Swallowing the argument turns every button inside a Link into a no-op.
   */
  onPress?: (event: GestureResponderEvent) => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
};

const BUTTON_SURFACE = {
  primary: 'bg-ink',
  secondary: 'bg-surface border border-line',
  ghost: 'bg-transparent',
  danger: 'bg-rose-soft border border-rose/30',
} as const;

const BUTTON_TEXT = {
  primary: 'text-paper',
  secondary: 'text-ink',
  ghost: 'text-muted',
  danger: 'text-rose',
} as const;

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  className = '',
}: ButtonProps) {
  const tones = useTones();
  const isDisabled = disabled || loading;
  const iconColor =
    variant === 'primary' ? tones.inverse : variant === 'danger' ? tones.rose : tones.ink;

  // Scale is applied here rather than in a wrapper so every button in the app
  // responds to touch without each screen opting in.
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      speed: 40,
      bounciness: 0,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPressIn={() => spring(0.97)}
      onPressOut={() => spring(1)}
      onPress={
        onPress
          ? (event) => {
              feedback(variant === 'danger' ? 'toggle' : 'tap');
              onPress(event);
            }
          : undefined
      }
      className={`flex-row items-center justify-center gap-2 rounded-xl ${
        size === 'sm' ? 'px-3 py-2' : 'px-4 py-3'
      } ${BUTTON_SURFACE[variant]} ${isDisabled ? 'opacity-40' : ''} ${className}`}
      style={{ transform: [{ scale }] }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 16} color={iconColor} />
      ) : null}
      <Text
        className={`${size === 'sm' ? 'text-sm' : 'text-[15px]'} font-semibold ${BUTTON_TEXT[variant]}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------ Card ------------------------------ */

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  // Tailwind resolves same-specificity utilities by their order in the emitted
  // stylesheet, not by order in the class attribute, so a caller passing
  // `bg-accent-soft` cannot reliably beat a hard-coded `bg-surface`. Drop the
  // default whenever the caller supplies its own background.
  const background = /(^|\s)bg-/.test(className) ? '' : 'bg-surface';

  return (
    <View className={`rounded-2xl border border-line p-5 ${background} ${className}`}>
      {children}
    </View>
  );
}

/* ----------------------------- Badge ------------------------------ */

const BADGE_TONE = {
  neutral: 'bg-sand',
  accent: 'bg-accent-soft',
  pine: 'bg-pine-soft',
  amber: 'bg-amber-soft',
  rose: 'bg-rose-soft',
} as const;

const BADGE_TEXT = {
  neutral: 'text-muted',
  accent: 'text-accent',
  pine: 'text-pine',
  amber: 'text-amber',
  rose: 'text-rose',
} as const;

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: keyof typeof BADGE_TONE;
}) {
  return (
    <View className={`self-start rounded-full px-2.5 py-1 ${BADGE_TONE[tone]}`}>
      <Text className={`text-xs font-semibold ${BADGE_TEXT[tone]}`}>{label}</Text>
    </View>
  );
}

/* --------------------------- Text field --------------------------- */

type FieldProps = TextInputProps & { label?: string; hint?: string };

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, hint, className = '', ...props },
  ref
) {
  const tones = useTones();
  return (
    <View className="gap-1.5">
      {label ? <Text className="text-sm font-medium text-muted">{label}</Text> : null}
      <TextInput
        ref={ref}
        placeholderTextColor={tones.subtle}
        className={`rounded-xl border border-line bg-surface px-4 py-3 text-base text-ink ${className}`}
        {...props}
      />
      {hint ? <Text className="text-xs text-subtle">{hint}</Text> : null}
    </View>
  );
});

/* --------------------------- Empty state -------------------------- */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <View className="items-center justify-center rounded-2xl border border-dashed border-line bg-surface/60 px-6 py-12">
      <View className="mb-4 h-12 w-12 items-center justify-center rounded-full bg-sand">
        <Icon name={icon} size={20} tone="muted" />
      </View>
      <Text className="mb-1.5 text-center font-heading text-base font-semibold text-ink">{title}</Text>
      <Text className="mb-5 max-w-sm text-center text-sm leading-5 text-muted">{body}</Text>
      {action}
    </View>
  );
}

/* ----------------------------- Loading ---------------------------- */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const tones = useTones();
  return (
    <View className="items-center justify-center gap-3 py-16">
      <ActivityIndicator color={tones.accent} />
      <Text className="text-sm text-muted">{label}</Text>
    </View>
  );
}

/* ----------------------------- Notices ---------------------------- */

export function Notice({
  tone = 'rose',
  title,
  body,
}: {
  tone?: 'rose' | 'amber' | 'pine';
  title: string;
  body?: string;
}) {
  const surface = { rose: 'bg-rose-soft', amber: 'bg-amber-soft', pine: 'bg-pine-soft' }[tone];
  const text = { rose: 'text-rose', amber: 'text-amber', pine: 'text-pine' }[tone];
  const icon = ({ rose: 'alert-circle', amber: 'alert-triangle', pine: 'check-circle' } as const)[
    tone
  ];

  return (
    <View className={`flex-row gap-3 rounded-xl p-3.5 ${surface}`}>
      <Icon name={icon} size={16} tone={tone} style={{ marginTop: 2 }} />
      <View className="flex-1 gap-1">
        <Text className={`text-sm font-semibold ${text}`}>{title}</Text>
        {body ? <Text className="text-sm leading-5 text-ink/80">{body}</Text> : null}
      </View>
    </View>
  );
}

/* --------------------------- Page header -------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <View className="mb-5 flex-row flex-wrap items-end justify-between gap-4">
      <View className="flex-1 gap-1.5" style={{ minWidth: 220 }}>
        {/*
          A real heading, not text that happens to be large.

          React Native renders every Text as a plain box, so a screen reader
          arriving on any screen in this app found no landmark to jump to and
          had to read from the top. Every screen goes through this component,
          so one role here gives all of them a heading to navigate by.
        */}
        <Text
          accessibilityRole="header"
          // Two lines, then an ellipsis. A course called "Fundamentals of
          // Digital Competency for Undergraduate Studies" is four lines of
          // 28pt type on a phone, and the page starts underneath it.
          numberOfLines={2}
          className="font-heading text-[28px] font-bold leading-8 tracking-tight text-ink"
        >
          {title}
        </Text>
        {subtitle ? <Text className="text-[15px] leading-6 text-muted">{subtitle}</Text> : null}
      </View>
      {/*
        Wraps. Without it a header with three actions squeezes them until the
        labels clip — "Import academic calenda…" — because a flex row with no
        wrap will shrink its children before it will ever break the line. Every
        page header in the app shares this, so the fault was never local to the
        one screen it was noticed on.
      */}
      {actions ? (
        <View className="flex-row flex-wrap items-center gap-2">{actions}</View>
      ) : null}
    </View>
  );
}

/* ---------------------------- Icon chip --------------------------- */

export function IconButton({
  icon,
  onPress,
  label,
  tone = 'muted',
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  tone?: 'muted' | 'rose';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-9 w-9 items-center justify-center rounded-lg"
    >
      <Icon name={icon} size={16} tone={tone === 'rose' ? 'rose' : 'muted'} />
    </Pressable>
  );
}

export type { IconName };
