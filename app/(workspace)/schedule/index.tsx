import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HubTabs } from '@/components/HubTabs';
import { ScheduleImportReview } from '@/components/ScheduleImportReview';
import Timetable from '../timetable';
import Calendar from '../calendar';
import Program from '../program';

type ScheduleTab = 'timetable' | 'calendar' | 'terms';

const TABS = [
  { id: 'timetable', label: 'Full Timetable', icon: 'calendar-days' },
  { id: 'calendar', label: 'Interactive Calendar', icon: 'calendar' },
  { id: 'terms', label: 'Term Management', icon: 'layers' },
] as const;

export default function ScheduleSurface() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; view?: string }>();
  const tab: ScheduleTab = TABS.some((entry) => entry.id === params.tab)
    ? (params.tab as ScheduleTab)
    : 'timetable';
  const reviewing = params.view === 'review';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <HubTabs
        tabs={TABS}
        value={tab}
        onChange={(next) => router.replace(`/schedule?tab=${next}` as never)}
      />
      <View className="min-h-0 flex-1">
        {reviewing ? (
          <ScheduleImportReview />
        ) : tab === 'calendar' ? (
          <Calendar />
        ) : tab === 'terms' ? (
          <Program />
        ) : (
          <Timetable />
        )}
      </View>
    </View>
  );
}
