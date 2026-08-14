import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import Reader from '../../reader/[subjectId]';

export default function KnowledgeReader() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value="reader" />
      <View className="min-h-0 flex-1">
        <Reader parentHref={`/knowledge/subject/${subjectId}`} />
      </View>
    </View>
  );
}
