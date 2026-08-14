import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { feedback } from '@/lib/sound';

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
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  if (active) return;
                  feedback('toggle');
                  onChange(tab.id);
                }}
                className={`h-10 min-w-0 flex-1 flex-row items-center justify-center rounded-xl sm:h-auto sm:flex-none sm:px-3.5 sm:py-2.5 ${
                  active ? 'bg-ink' : 'bg-transparent'
                }`}
              >
                <Icon name={tab.icon} size={15} color={active ? '#FFFFFF' : '#6F6A5F'} />
                <Text
                  className={`hidden text-sm font-semibold sm:ml-2 sm:inline ${
                    active ? 'text-white' : 'text-muted'
                  }`}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
