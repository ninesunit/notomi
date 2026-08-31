import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HubTabs } from '@/components/HubTabs';
import Friends from '../friends';
import { lazyScreen } from '@/components/lazyScreen';

const Arena = lazyScreen(() => import('@/components/social/Arena'), 'Arena', 'Opening the arena…');
const Messages = lazyScreen<{ initialConversationId?: string; initialRecipientId?: string }>(
  () => import('@/components/social/Messages'),
  'Messages',
  'Opening messages...'
);
const GroupSprints = lazyScreen(
  () => import('@/components/social/GroupSprints'),
  'GroupSprints',
  'Opening your sprints…'
);

type SocialTab = 'search' | 'messages' | 'arena' | 'sprints';

const TABS = [
  { id: 'search', label: 'User Search', icon: 'search' },
  { id: 'messages', label: 'Messages', icon: 'message-circle' },
  { id: 'arena', label: 'Quiz Battles', icon: 'trophy' },
  { id: 'sprints', label: 'Group Sprints', icon: 'users-round' },
] as const;

export default function SocialHub() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; conversation?: string; recipient?: string }>();
  const tab: SocialTab = TABS.some((entry) => entry.id === params.tab)
    ? (params.tab as SocialTab)
    : 'search';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <HubTabs tabs={TABS} value={tab} onChange={(next) => router.setParams({ tab: next })} />
      <View className="min-h-0 flex-1">
        {tab === 'search' ? (
          <Friends />
        ) : tab === 'messages' ? (
          <Messages initialConversationId={params.conversation} initialRecipientId={params.recipient} />
        ) : tab === 'arena' ? (
          <Arena />
        ) : (
          <GroupSprints />
        )}
      </View>
    </View>
  );
}
