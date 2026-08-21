import { Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { feedback } from '@/lib/sound';
import { Touchable } from '@/components/ui';

export type HubTab<T extends string> = {
  id: T;
  label: string;
  icon: IconName;
};

/**
 * Icons on a phone, labels once there is room.
 *
 * These were equal-width flexible buttons, which is fine for five and absurd
 * for two: Task Board and Focus Room each took half the screen, so a tab strip
 * read as two enormous panels rather than as a control. The group is now only
 * as wide as its contents, centred, with the active tab in a compact pill.
 *
 * Never scrolls sideways. A row of icons that runs off the edge is a row with
 * destinations nobody will find.
 */
export function HubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly HubTab<T>[];
  value: T;
  onChange: (tab: T) => void;
}) {
  return (
    <View className="shrink-0 border-b border-line bg-paper">
      <View className="w-full self-center px-4 py-2 sm:px-5 sm:py-3 md:px-10" style={{ maxWidth: 1160 }}>
        <View className="flex-row items-center justify-center gap-1 self-center sm:justify-start sm:self-start">
          {tabs.map((tab) => {
            const active = tab.id === value;
            return (
              <Touchable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                // The label beside the icon is hidden below `sm`, which leaves
                // this with no accessible name on the device most likely to be
                // driven by a screen reader. Naming it here covers both widths;
                // the visible text is decorative once this exists.
                accessibilityLabel={tab.label}
                // This tab plays its own cue, and only when the selection
                // actually changes. Touchable contributes the press animation
                // and stays quiet rather than doubling the sound.
                cue="none"
                onPress={() => {
                  if (active) return;
                  feedback('toggle');
                  onChange(tab.id);
                }}
                className={`h-11 w-11 flex-row items-center justify-center rounded-xl sm:h-auto sm:w-auto sm:px-3.5 sm:py-2.5 ${
                  active ? 'bg-ink' : 'bg-transparent'
                }`}
              >
                <Icon name={tab.icon} size={15} tone={active ? 'inverse' : 'muted'} />
                <Text
                  className={`hidden text-sm font-semibold sm:ml-2 sm:inline ${
                    active ? 'text-paper' : 'text-muted'
                  }`}
                >
                  {tab.label}
                </Text>
              </Touchable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
