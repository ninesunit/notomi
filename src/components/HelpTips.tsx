import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button } from '@/components/ui';

const TIPS: Array<{
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
  body: string;
}> = [
  {
    icon: 'calendar',
    title: 'Start with the schedule',
    body: 'Upload a screenshot, PDF or ICS file. Review every class before Notomi saves it.',
  },
  {
    icon: 'book-open',
    title: 'Build each course folder',
    body: 'Add a syllabus, slides, notes or a past paper. Subjects remain the parent of every material and class.',
  },
  {
    icon: 'zap',
    title: 'Ask with context',
    body: 'Open Reader and Ask Notomi use the course materials you already chose, so answers stay grounded.',
  },
  {
    icon: 'bell',
    title: 'Install for background alerts',
    body: 'Add Notomi to the Home Screen, then enable reminders in Settings. iPhone web tabs cannot receive closed-app push alerts.',
  },
];

export function HelpTips({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Help & tips" icon="help-circle" variant="auto">
      <View className="gap-4 p-5">
        <View className="gap-1">
          <Text className="text-base font-semibold text-ink">A reliable first semester setup</Text>
          <Text className="text-sm leading-5 text-muted">
            Notomi keeps imports staged until you approve them. Nothing below needs a paid add-on.
          </Text>
        </View>

        <View className="gap-2">
          {TIPS.map((tip, index) => (
            <View key={tip.title} className="flex-row gap-3 rounded-xl bg-paper px-3.5 py-3">
              <View className="h-8 w-8 items-center justify-center rounded-lg bg-accent-soft">
                <Icon name={tip.icon} size={15} tone="accent" />
              </View>
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-semibold text-ink">
                  {index + 1}. {tip.title}
                </Text>
                <Text className="text-xs leading-4 text-muted">{tip.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Open Dashboard"
            icon="layout-dashboard"
            size="sm"
            onPress={() => {
              onClose();
              router.push('/dashboard');
            }}
          />
          <Button
            label="Reminder settings"
            icon="bell"
            variant="secondary"
            size="sm"
            onPress={() => {
              onClose();
              router.push('/settings');
            }}
          />
        </View>
      </View>
    </Sheet>
  );
}
