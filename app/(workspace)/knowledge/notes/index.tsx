import { View } from 'react-native';

import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import { lazyScreen } from '@/components/lazyScreen';

const NotebookShelf = lazyScreen(
  () => import('@/components/notes/NotebookShelf'),
  'NotebookShelf',
  'Opening your notebooks…'
);

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
