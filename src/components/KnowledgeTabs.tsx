import { useRouter } from 'expo-router';
import { HubTabs } from './HubTabs';

export type KnowledgeTab = 'folders' | 'reader' | 'vault' | 'notes';

const KNOWLEDGE_TABS = [
  { id: 'folders', label: 'Course Folders', icon: 'book-open' },
  { id: 'reader', label: 'Open Reader', icon: 'message-circle' },
  { id: 'vault', label: 'Document Vault', icon: 'folder-kanban' },
  { id: 'notes', label: 'Notomi Notes', icon: 'pen-tool' },
] as const;

export function KnowledgeTabs({ value }: { value: KnowledgeTab }) {
  const router = useRouter();
  return (
    <HubTabs
      tabs={KNOWLEDGE_TABS}
      value={value}
      onChange={(tab) =>
        router.replace((tab === 'notes' ? '/knowledge/notes' : `/knowledge?tab=${tab}`) as never)
      }
    />
  );
}
