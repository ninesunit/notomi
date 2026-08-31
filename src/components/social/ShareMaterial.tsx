import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { orderBy, query } from 'firebase/firestore';
import { Sheet } from '@/components/Sheet';
import { Button, Notice } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Flashcard, SourceDocument, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { shareWithFriend, type ShareKind } from '@/services/sharing';
import type { Friend } from '@/services/social';

/**
 * Sharing a copy of something with one friend.
 *
 * Works two ways on purpose. Left alone it renders its own Share button, which
 * is what the inbox and the profile page want. Passed `open`, the button
 * disappears and the caller drives it — the friends list moved sharing into an
 * overflow sheet, and a button inside a menu item that opens a second sheet is
 * one tap more than the menu item itself should have cost.
 */
export function ShareMaterial({
  friend,
  open,
  onClose,
  onShared,
}: {
  friend: Friend;
  open?: boolean;
  onClose?: () => void;
  onShared?: (share: {
    shareId: string;
    kind: ShareKind;
    title: string;
    subjectName: string;
  }) => void | Promise<void>;
}) {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();
  const controlled = open !== undefined;
  const [own, setOwn] = useState(false);
  const visible = controlled ? open === true : own;
  const setVisible = (next: boolean) => {
    if (controlled) {
      if (!next) onClose?.();
      return;
    }
    setOwn(next);
  };
  const subjects = useCollection<Subject>(visible ? query(paths.subjects(db, uid), orderBy('name')) : null, [uid, visible]);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const selected = subjects.data.find((subject) => subject.id === subjectId) ?? subjects.data[0] ?? null;
  const documents = useCollection<SourceDocument>(
    visible && selected ? paths.documents(db, uid, selected.id) : null,
    [uid, visible, selected?.id]
  );
  const flashcards = useCollection<Flashcard>(
    visible && selected ? paths.flashcards(db, uid, selected.id) : null,
    [uid, visible, selected?.id]
  );
  const [kind, setKind] = useState<ShareKind>('summary');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = useMemo(() => {
    if (!selected) return null;
    if (kind === 'flashcards') {
      return {
        title: `${selected.name} flashcards`,
        content: flashcards.data.map((card) => `## ${card.front}\n\n${card.back}`).join('\n\n'),
        sourceFileName: null,
      };
    }
    if (kind === 'summary') {
      return {
        title: `${selected.name} summary`,
        content: documents.data
          .filter((document) => document.summary || document.notes)
          .map((document) => `## ${document.title}\n\n${document.notes || document.summary}`)
          .join('\n\n'),
        sourceFileName: null,
      };
    }
    const document = documents.data.find((entry) => entry.id === documentId) ?? documents.data[0];
    return document
      ? { title: document.title, content: document.notes || document.rawText, sourceFileName: document.fileName }
      : null;
  }, [selected, kind, flashcards.data, documents.data, documentId]);

  async function send() {
    if (!selected || !payload) return;
    setBusy(true);
    setError(null);
    try {
      const shareId = await shareWithFriend(
        {
          senderId: uid,
          senderName: user?.displayName || user?.email?.split('@')[0] || 'A friend',
          recipientId: friend.id,
          recipientName: friend.displayName,
          kind,
          subjectId: selected.id,
          subjectName: selected.name,
          title: payload.title,
          content: payload.content,
          sourceFileName: payload.sourceFileName,
        },
        { notifyInbox: !onShared }
      );
      await onShared?.({
        shareId,
        kind,
        title: payload.title,
        subjectName: selected.name,
      });
      setVisible(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {controlled ? null : (
        <Button label="Share" icon="share-2" size="sm" variant="ghost" onPress={() => setVisible(true)} />
      )}
      <Sheet
        visible={visible}
        onClose={() => setVisible(false)}
        title={`Share with ${friend.displayName}`}
        icon="share-2"
        maxHeight={650}
        footer={
          <>
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => setVisible(false)} disabled={busy} />
            <View className="flex-1" />
            <Button label="Send read-only copy" icon="send" size="sm" loading={busy} disabled={!payload?.content} onPress={() => void send()} />
          </>
        }
      >
        {error ? <Notice title="Could not share that item" body={error} /> : null}
        <PickerLabel label="Subject" />
        <View className="flex-row flex-wrap gap-2">
          {subjects.data.map((subject) => (
            <Chip key={subject.id} label={subject.moduleCode || subject.name} active={selected?.id === subject.id} onPress={() => setSubjectId(subject.id)} />
          ))}
        </View>
        <PickerLabel label="Share as" />
        <View className="flex-row flex-wrap gap-2">
          <Chip label="Summary" active={kind === 'summary'} onPress={() => setKind('summary')} />
          <Chip label="Material" active={kind === 'material'} onPress={() => setKind('material')} />
          <Chip label="Flashcard deck" active={kind === 'flashcards'} onPress={() => setKind('flashcards')} />
        </View>
        {kind === 'material' ? (
          <>
            <PickerLabel label="Material" />
            <View className="gap-2">
              {documents.data.map((document) => (
                <Chip key={document.id} label={document.title} active={(documentId ?? documents.data[0]?.id) === document.id} onPress={() => setDocumentId(document.id)} />
              ))}
            </View>
          </>
        ) : null}
        <Text className="text-xs leading-5 text-subtle">
          The recipient gets a read-only copy in Shared with Me. Your original remains private and unchanged.
        </Text>
      </Sheet>
    </>
  );
}

function PickerLabel({ label }: { label: string }) {
  return <Text className="text-sm font-medium text-muted">{label}</Text>;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className={`self-start rounded-xl px-3 py-2 ${active ? 'bg-ink' : 'bg-sand'}`}>
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}
