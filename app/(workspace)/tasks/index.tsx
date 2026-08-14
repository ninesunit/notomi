import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HubTabs } from '@/components/HubTabs';
import TaskBoard from '../todos';
import FocusRoom from '../focus';

type TasksTab = 'board' | 'focus';

const TABS = [
  { id: 'board', label: 'Task Board', icon: 'check-square' },
  { id: 'focus', label: 'Focus Room', icon: 'timer' },
] as const;

export default function TasksSurface() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab: TasksTab = params.tab === 'focus' ? 'focus' : 'board';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <HubTabs tabs={TABS} value={tab} onChange={(next) => router.replace(`/tasks?tab=${next}` as never)} />
      <View className="min-h-0 flex-1">{tab === 'focus' ? <FocusRoom /> : <TaskBoard />}</View>
    </View>
  );
}
