import { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { deleteDoc, doc, increment, orderBy, query, updateDoc } from 'firebase/firestore';
import { deleteObject, ref } from 'firebase/storage';
import { ScreenScroll } from '@/components/ScreenScroll';
import { UploadButton } from '@/components/UploadButton';
import { Badge, Button, Card, EmptyState, IconButton, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { formatDateTime } from '@/lib/dates';
import { getBucket, getDb } from '@/lib/firebase';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject } from '@/lib/schema';

export default function SubjectFolder() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const uid = useUid();
  const router = useRouter();
  const db = getDb();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subject = useDocument<Subject>(paths.subject(db, uid, subjectId), [uid, subjectId]);
  const documents = useCollection<SourceDocument>(
    query(paths.documents(db, uid, subjectId), orderBy('createdAt', 'desc')),
    [uid, subjectId]
  );

  /** Task 3 asks for modules grouped inside the folder. */
  const modules = useMemo(() => {
    const groups = new Map<string, SourceDocument[]>();
    for (const document of documents.data) {
      const key = document.moduleCode?.trim() || 'Ungrouped';
      const bucket = groups.get(key);
      if (bucket) bucket.push(document);
      else groups.set(key, [document]);
    }
    // "Ungrouped" always sorts last so real module codes lead.
    return [...groups.entries()].sort(([a], [b]) =>
      a === 'Ungrouped' ? 1 : b === 'Ungrouped' ? -1 : a.localeCompare(b)
    );
  }, [documents.data]);

  const totalChars = useMemo(
    () => documents.data.reduce((total, document) => total + (document.charCount ?? 0), 0),
    [documents.data]
  );

  async function removeDocument(document: SourceDocument) {
    setError(null);
    setRemoving(document.id);
    try {
      if (document.storagePath) {
        // A missing object must not block removing the Firestore record.
        await deleteObject(ref(getBucket(), document.storagePath)).catch(() => undefined);
      }
      await deleteDoc(paths.document(db, uid, subjectId, document.id));
      await updateDoc(paths.subject(db, uid, subjectId), { documentCount: increment(-1) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoving(null);
    }
  }

  async function removeSubject() {
    setError(null);
    try {
      await Promise.all(
        documents.data.map((document) =>
          document.storagePath
            ? deleteObject(ref(getBucket(), document.storagePath)).catch(() => undefined)
            : Promise.resolve()
        )
      );
      await Promise.all(
        documents.data.map((document) =>
          deleteDoc(paths.document(db, uid, subjectId, document.id))
        )
      );
      await deleteDoc(doc(paths.subjects(db, uid), subjectId));
      router.replace('/library');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (subject.loading) {
    return (
      <ScreenScroll>
        <Loading label="Opening subject…" />
      </ScreenScroll>
    );
  }

  if (!subject.data) {
    return (
      <ScreenScroll>
        <EmptyState
          icon="folder"
          title="Subject not found"
          body="This folder may have been deleted."
          action={
            <Link href="/library" asChild>
              <Button label="Back to library" variant="secondary" />
            </Link>
          }
        />
      </ScreenScroll>
    );
  }

  const hasText = documents.data.some((document) => (document.charCount ?? 0) > 0);

  return (
    <ScreenScroll>
      <Link href="/library" asChild>
        <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
          <Feather name="chevron-left" size={15} color="#6F6A5F" />
          <Text className="text-sm font-medium text-muted">Library</Text>
        </Pressable>
      </Link>

      <PageHeader
        title={subject.data.name}
        subtitle={[
          subject.data.moduleCode,
          `${documents.data.length} ${documents.data.length === 1 ? 'source' : 'sources'}`,
          totalChars > 0 ? `${Math.round(totalChars / 1000)}k characters of context` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <Link href={`/reader/${subjectId}`} asChild>
              <Button label="Open Reader" icon="message-circle" size="sm" disabled={!hasText} />
            </Link>
            <Link href={`/study?subjectId=${subjectId}`} asChild>
              <Button label="Take Quiz" icon="zap" variant="secondary" size="sm" disabled={!hasText} />
            </Link>
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Something went wrong" body={error} />
        </View>
      ) : null}

      <View className="mb-8">
        <UploadButton subjectId={subjectId} label="Add to this subject" variant="secondary" size="sm" />
      </View>

      {documents.loading ? (
        <Loading label="Loading sources…" />
      ) : documents.data.length === 0 ? (
        <EmptyState
          icon="file-plus"
          title="No sources in this subject"
          body="Add lecture slides, notes or a syllabus and they will show up here."
        />
      ) : (
        <View className="gap-8">
          {modules.map(([moduleCode, moduleDocuments]) => (
            <View key={moduleCode} className="gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                  {moduleCode}
                </Text>
                <View className="h-px flex-1 bg-line" />
                <Text className="text-xs text-subtle">{moduleDocuments.length}</Text>
              </View>

              <View className="gap-3">
                {moduleDocuments.map((document) => (
                  <Card key={document.id} className="gap-3">
                    <View className="flex-row items-start gap-3">
                      <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-lg bg-sand">
                        <Feather
                          name={document.mimeType?.includes('pdf') ? 'file-text' : 'file'}
                          size={15}
                          color="#6F6A5F"
                        />
                      </View>

                      <View className="flex-1 gap-1">
                        <Text className="text-[15px] font-semibold leading-5 text-ink">
                          {document.fileName}
                        </Text>
                        <Text className="text-xs text-subtle">
                          {[
                            formatDateTime(document.createdAt),
                            document.charCount
                              ? `${Math.round(document.charCount / 1000)}k chars`
                              : null,
                            document.sizeBytes
                              ? `${(document.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>

                      <View className="flex-row items-center">
                        {document.downloadUrl ? (
                          <IconButton
                            icon="download"
                            label={`Download ${document.fileName}`}
                            onPress={() => void Linking.openURL(document.downloadUrl!)}
                          />
                        ) : null}
                        <IconButton
                          icon={removing === document.id ? 'loader' : 'trash-2'}
                          tone="rose"
                          label={`Remove ${document.fileName}`}
                          onPress={() => void removeDocument(document)}
                        />
                      </View>
                    </View>

                    {document.summary ? (
                      <Text className="text-sm leading-6 text-ink/75">{document.summary}</Text>
                    ) : null}

                    {document.error ? <Badge label="Analysed with warnings" tone="amber" /> : null}
                  </Card>
                ))}
              </View>
            </View>
          ))}
        </View>
      )}

      {documents.data.length > 0 ? (
        <View className="mt-10 items-start border-t border-line pt-6">
          <Button label="Delete subject" variant="danger" size="sm" icon="trash-2" onPress={() => void removeSubject()} />
          <Text className="mt-2 text-xs text-subtle">
            Removes this folder, its {documents.data.length} source
            {documents.data.length === 1 ? '' : 's'} and their uploaded files.
          </Text>
        </View>
      ) : null}
    </ScreenScroll>
  );
}
