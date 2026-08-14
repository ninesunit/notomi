import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Sheet } from './Sheet';

export type TermPickerOption = {
  id: string;
  label: string;
  count?: number;
  current?: boolean;
};

export function ResponsiveTermPicker({
  options,
  value,
  onChange,
  title = 'Select term',
  placeholder,
  sheetIcon = 'calendar',
}: {
  options: TermPickerOption[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
  placeholder?: string;
  sheetIcon?: IconName;
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
      <View className="sm:hidden">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}: ${selected.label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(true)}
          className="h-11 max-w-full flex-row items-center rounded-xl border border-line bg-surface px-3.5"
        >
          <Text
            className="max-w-[250px] min-w-0 flex-1 truncate text-sm font-semibold text-ink"
            numberOfLines={1}
          >
            {selected.label}
          </Text>
          {selected.count !== undefined ? (
            <Text className="ml-2 text-xs text-subtle">{selected.count}</Text>
          ) : null}
          <View className="ml-2">
            <Icon name="chevron-down" size={16} color="#6F6A5F" />
          </View>
        </Pressable>
      </View>

      <View className="hidden flex-row flex-wrap gap-1.5 sm:flex">
        {options.map((option) => (
          <TermPill
            key={option.id}
            option={option}
            active={option.id === value}
            onPress={() => choose(option.id)}
          />
        ))}
      </View>

      <Sheet visible={open} onClose={() => setOpen(false)} title={title} icon={sheetIcon}>
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
                  {option.count !== undefined ? (
                    <Text className="mt-0.5 text-xs text-subtle">
                      {option.count} {option.count === 1 ? 'subject' : 'subjects'}
                    </Text>
                  ) : null}
                </View>
                {active ? <Icon name="check" size={17} color="#18181B" /> : null}
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
