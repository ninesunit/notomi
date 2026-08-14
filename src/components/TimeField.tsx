import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { minutesTo12h } from '@/lib/schema';
import { feedback } from '@/lib/sound';
import { Reveal } from './motion';

/**
 * A time, picked rather than typed.
 *
 * The field this replaces was a text box with "09:00" as its placeholder, which
 * left a student guessing whether it wanted 24-hour time and with nowhere to
 * say PM. The value here is minutes from midnight — there is no format to get
 * wrong — and the control is three rows of chips, so setting 2:30 PM is three
 * taps and no keyboard.
 */

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

export function TimeField({
  label,
  value,
  onChange,
  hint,
  /** Times before this are shown as invalid — an end before its start. */
  invalid = false,
}: {
  label: string;
  /** Minutes from midnight. */
  value: number;
  onChange: (minutes: number) => void;
  hint?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const hour24 = Math.floor(value / 60);
  const minute = value % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const isPm = hour24 >= 12;

  /** Rebuilds the value from whichever part changed, keeping the other two. */
  const set = (parts: { hour12?: number; minute?: number; pm?: boolean }) => {
    const nextHour12 = parts.hour12 ?? hour12;
    const nextMinute = parts.minute ?? minute;
    const nextPm = parts.pm ?? isPm;

    // 12 AM is midnight and 12 PM is noon: the hour that wraps, not adds.
    const base = nextHour12 % 12;
    onChange((base + (nextPm ? 12 : 0)) * 60 + nextMinute);
    feedback('toggle');
  };

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-muted">{label}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}: ${minutesTo12h(value)}`}
        onPress={() => {
          feedback('tap');
          setOpen((current) => !current);
        }}
        className={`flex-row items-center justify-between rounded-xl border px-4 py-3 ${
          invalid ? 'border-rose bg-rose-soft' : open ? 'border-accent bg-paper' : 'border-line bg-surface'
        }`}
      >
        <Text className={`text-[17px] font-semibold ${invalid ? 'text-rose' : 'text-ink'}`}>
          {minutesTo12h(value)}
        </Text>
        <Icon name={open ? 'chevron-up' : 'clock'} size={16} color="#6F6A5F" />
      </Pressable>

      {hint ? <Text className="text-xs text-subtle">{hint}</Text> : null}

      <Reveal open={open}>
        <View className="gap-2.5 rounded-xl border border-line bg-paper p-3">
          <Row label="Hour">
            {HOURS.map((option) => (
              <Chip
                key={option}
                label={String(option)}
                selected={option === hour12}
                onPress={() => set({ hour12: option })}
              />
            ))}
          </Row>

          <Row label="Minute">
            {MINUTES.map((option) => (
              <Chip
                key={option}
                label={String(option).padStart(2, '0')}
                selected={option === minute}
                onPress={() => set({ minute: option })}
              />
            ))}
          </Row>

          <Row label="AM / PM">
            <Chip label="AM" selected={!isPm} onPress={() => set({ pm: false })} wide />
            <Chip label="PM" selected={isPm} onPress={() => set({ pm: true })} wide />
          </Row>
        </View>
      </Reveal>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-[11px] font-bold uppercase tracking-wider text-subtle">{label}</Text>
      <View className="flex-row flex-wrap gap-1">{children}</View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  wide = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      className={`items-center justify-center rounded-lg py-2 ${wide ? 'px-5' : 'min-w-[38px] px-2'} ${
        selected ? 'bg-ink' : 'bg-sand'
      }`}
    >
      <Text
        className={`text-[13px] font-semibold ${selected ? 'text-paper' : 'text-ink'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
