import { View } from 'react-native';
import { KnowledgeTabs } from '@/components/KnowledgeTabs';
import DocumentReader from '../../../library/[subjectId]/[docId]';

export default function KnowledgeDocument() {
  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value="vault" />
      <View className="min-h-0 flex-1">
        <DocumentReader basePath="/knowledge/subject" />
      </View>
    </View>
  );
}
