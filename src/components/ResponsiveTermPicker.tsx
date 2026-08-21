import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Sheet } from './Sheet';

export type TermPickerOption = {
  id: string;
  label: string;
  count?: number;
  current?: boolean;
  /** Overrides the "N subjects" wording in the sheet. */
  detail?: string;
};

export function ResponsiveTermPicker({
  options,
  value,
  onChange,
  title = 'Select term',
  placeholder,
  sheetIcon = 'calendar',
  /**
   * Stay a dropdown at every width.
   *
   * The pill wall is right for four terms and wrong for twenty tasks: on a
   * desktop the Focus Room laid eleven task pills between the clock and the
   * Start button and pushed Start off the card. A list that can grow without
   * bound is a list, not a row of choices, whatever the screen is.
   */
  alwaysDropdown = false,
  icon,
}: {
  options: TermPickerOption[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
  placeholder?: string;
  sheetIcon?: IconName;
  alwaysDropdown?: boolean;
  /** Shown inside the closed control, for a picker that is not about terms. */
  icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    options.find((option) => option.id === value) ??
    (placeholder ? { id: '', label: placeholder } : options[0]);

  if (!selected) return null;

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <View className={alwaysDropdown ? '' : 'sm:hidden'}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}: ${selected.label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(true)}
          className="h-11 max-w-full flex-row items-center gap-2 rounded-xl border border-line bg-surface px-3.5"
        >
          {icon ? <Icon name={icon} size={15} tone="muted" /> : null}
          <Text
            className="min-w-0 flex-1 truncate text-sm font-semibold text-ink"
            numberOfLines={1}
          >
            {selected.label}
          </Text>
          {selected.count !== undefined ? (
            <Text className="ml-2 text-xs text-subtle">{selected.count}</Text>
          ) : null}
          <View className="ml-2">
            <Icon name="chevron-down" size={16} tone="muted" />
          </View>
        </Pressable>
      </View>

      <View className={alwaysDropdown ? 'hidden' : 'hidden flex-row flex-wrap gap-1.5 sm:flex'}>
        {options.map((option) => (
          <TermPill
            key={option.id}
            option={option}
            active={option.id === value}
            onPress={() => choose(option.id)}
          />
        ))}
      </View>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={title}
        icon={sheetIcon}
        maxHeight={520}
      >
        <View className="gap-2">
          {options.map((option) => {
            const active = option.id === value;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => choose(option.id)}
                className={`min-h-12 flex-row items-center rounded-xl border px-4 py-3 ${
                  active ? 'border-ink bg-sand' : 'border-line bg-surface'
                }`}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-ink">{option.label}</Text>
                  {option.detail ? (
                    <Text className="mt-0.5 text-xs text-subtle" numberOfLines={1}>
                      {option.detail}
                    </Text>
                  ) : option.count !== undefined ? (
                    <Text className="mt-0.5 text-xs text-subtle">
                      {option.count} {option.count === 1 ? 'subject' : 'subjects'}
                    </Text>
                  ) : null}
                </View>
                {active ? <Icon name="check" size={17} tone="ink" /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}

function TermPill({
  option,
  active,
  onPress,
}: {
  option: TermPickerOption;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${option.label}${option.count === undefined ? '' : `, ${option.count} subjects`}`}
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-full border px-3.5 py-2 ${
        active ? 'border-ink bg-ink' : 'border-line bg-surface'
      }`}
    >
      {option.current ? <View className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
      <Text className={`text-[13px] font-semibold ${active ? 'text-paper' : 'text-muted'}`}>
        {option.label}
      </Text>
      {option.count !== undefined ? (
        <Text className={`text-[11px] ${active ? 'text-paper/60' : 'text-subtle'}`}>
          {option.count}
        </Text>
      ) : null}
    </Pressable>
  );
}
