import { Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/Icon';
import { Touchable } from '@/components/ui';
import { useSafeArea } from '@/hooks/useSafeArea';

/**
 * The one action a screen is for, kept reachable while the content scrolls.
 *
 * Used where a creation form would otherwise sit permanently at the top of a
 * list. On a phone that form is the whole first screen — the Task Board spent
 * about six hundred of eight hundred points on one before a single task showed
 * — and it is in the way every time the student is reading rather than adding.
 * A button that stays put costs nothing until it is wanted.
 *
 * Positioned clear of the undo toast rather than beside it. The toast is
 * centred, up to 384 points wide, and sits at `insets.bottom + 76`
 * (src/hooks/useUndo.tsx), so on a phone it spans nearly the full width: a
 * bottom-right button at the same height would be underneath it exactly when
 * the student is reaching for Undo. This sits below that line, so the toast
 * rises above the button instead of over it.
 */
export function FloatingAction({
  icon = 'plus',
  label,
  onPress,
  extended = false,
}: {
  icon?: IconName;
  /** Read by screen readers; shown as text when `extended`. */
  label: string;
  onPress: () => void;
  /** Show the label beside the icon. For a screen whose action is not obvious. */
  extended?: boolean;
}) {
  const insets = useSafeArea();

  return (
    <View
      pointerEvents="box-none"
      className="absolute bottom-0 left-0 right-0 z-40 items-end"
      style={{
        // 16 puts the 56-point button at 16–72, just under the toast's 76.
        paddingBottom: insets.bottom + 16,
        paddingRight: insets.right + 20,
      }}
    >
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        scaleTo={0.94}
        className={`h-14 flex-row items-center justify-center rounded-2xl bg-ink shadow-lg ${
          extended ? 'gap-2 px-5' : 'w-14'
        }`}
      >
        <Icon name={icon} size={22} color="#F7F5EE" />
        {extended ? (
          <Text className="text-[15px] font-semibold text-paper">{label}</Text>
        ) : null}
      </Touchable>
    </View>
  );
}
