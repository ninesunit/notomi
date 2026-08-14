import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Markdown } from '@/components/Markdown';
import { Sheet } from '@/components/Sheet';
import { Card, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import { getDb } from '@/services/firebase';
import type { MaterialShare } from '@/services/sharing';

export function SharedWithMe() {
  const uid = useUid();
  const shares = useCollection<MaterialShare>(
    paths.sharedMaterials(getDb(), uid),
    [uid]
  );
  const [selected, setSelected] = useState<MaterialShare | null>(null);

  if (shares.loading) return <Loading label="Loading shared notes…" />;
  if (shares.error) return <Notice title="Could not load shared notes" body={shares.error.message} />;
  if (!shares.data.length) return null;

  return (
    <View className="mb-8 gap-3">
      <View className="flex-row items-center gap-2">
        <Icon name="share-2" size={17} color="#B4552D" />
        <Text className="font-heading text-lg text-ink">Shared with Me</Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        {shares.data.map((share) => (
          <Pressable key={share.id} onPress={() => setSelected(share)} className="min-w-[240px] max-w-sm flex-1">
            <Card className="gap-3">
              <View className="flex-row items-center gap-2">
                <Icon name={share.kind === 'flashcards' ? 'layers' : share.kind === 'summary' ? 'file-text' : 'book-open'} size={16} color="#6F6A5F" />
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted">{share.kind}</Text>
              </View>
              <Text className="text-base font-semibold text-ink" numberOfLines={2}>{share.title}</Text>
              <Text className="text-xs text-subtle">From {share.senderName} · Read only</Text>
            </Card>
          </Pressable>
        ))}
      </View>
      <Sheet visible={selected !== null} onClose={() => setSelected(null)} title={selected?.title ?? 'Shared item'} icon="share-2" maxHeight={720}>
        {selected ? (
          <View className="gap-4">
            <Text className="text-xs text-muted">Shared by {selected.senderName} from {selected.subjectName}. This copy cannot edit their original.</Text>
            <Markdown source={selected.content} />
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
