import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import SubjectFolder from '../../../library/[subjectId]';

export default function KnowledgeSubject() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value="folders" />
      <View className="min-h-0 flex-1">
        <SubjectFolder
          basePath="/knowledge/subject"
          parentHref="/knowledge?tab=folders"
          readerPath={`/knowledge/reader/${subjectId}`}
        />
      </View>
    </View>
  );
}
