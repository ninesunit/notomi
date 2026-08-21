import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HubTabs } from '@/components/HubTabs';
import Friends from '../friends';
import { lazyScreen } from '@/components/lazyScreen';

const Arena = lazyScreen(() => import('@/components/social/Arena'), 'Arena', 'Opening the arena…');
const GroupSprints = lazyScreen(
  () => import('@/components/social/GroupSprints'),
  'GroupSprints',
  'Opening your sprints…'
);

type SocialTab = 'search' | 'arena' | 'sprints';

const TABS = [
  { id: 'search', label: 'User Search', icon: 'search' },
  { id: 'arena', label: 'Quiz Battles', icon: 'trophy' },
  { id: 'sprints', label: 'Group Sprints', icon: 'users-round' },
] as const;

export default function SocialHub() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab: SocialTab = TABS.some((entry) => entry.id === params.tab)
    ? (params.tab as SocialTab)
    : 'search';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <HubTabs tabs={TABS} value={tab} onChange={(next) => router.setParams({ tab: next })} />
      <View className="min-h-0 flex-1">
        {tab === 'search' ? <Friends /> : tab === 'arena' ? <Arena /> : <GroupSprints />}
      </View>
    </View>
  );
}
