import { View } from 'react-native';
import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import { NotebookShelf } from '@/components/notes/NotebookShelf';

export default function NotesShelfSurface() {
  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value="notes" />
      <View className="min-h-0 flex-1">
        <NotebookShelf />
      </View>
    </View>
  );
}
