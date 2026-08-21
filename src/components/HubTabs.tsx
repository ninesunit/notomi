import { Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { feedback } from '@/lib/sound';
import { Touchable } from '@/components/ui';

export type HubTab<T extends string> = {
  id: T;
  label: string;
  icon: IconName;
};

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
      <View className="w-full self-center px-4 py-3 sm:px-5 md:px-10" style={{ maxWidth: 1160 }}>
        <View className="w-full flex-row items-center sm:w-auto sm:justify-start sm:gap-1">
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
                className={`h-11 min-w-0 flex-1 flex-row items-center justify-center rounded-xl sm:h-auto sm:flex-none sm:px-3.5 sm:py-2.5 ${
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
