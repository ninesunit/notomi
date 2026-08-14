import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import { NotomiNotes } from '@/components/notes/NotomiNotes';

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
