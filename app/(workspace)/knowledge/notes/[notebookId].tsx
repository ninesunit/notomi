import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import { lazyScreen } from '@/components/lazyScreen';

// The canvas is the largest thing in the app and nobody lands on it.
const NotomiNotes = lazyScreen<{ notebookId: string; initialPageId?: string }>(
  () => import('@/components/notes/NotomiNotes'),
  'NotomiNotes',
  'Opening your canvas…'
);

export default function NotebookEditorSurface() {
  const { notebookId, page } = useLocalSearchParams<{ notebookId: string; page?: string }>();
  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value="notes" />
      <View className="min-h-0 flex-1">
        <NotomiNotes notebookId={notebookId} initialPageId={page} />
      </View>
    </View>
  );
}
