import { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { deleteDoc, doc, orderBy, query } from 'firebase/firestore';
import { AddMaterialModal } from '@/components/AddMaterialModal';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, EmptyState, IconButton, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { formatDateTime } from '@/lib/dates';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject } from '@/lib/schema';
import { deleteMaterial } from '@/services/ingestion';
import { deleteR2File, getR2FileUrl } from '@/services/r2Storage';

/** Rounding to "k" alone renders a short handout as a misleading "0k". */
function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k chars`;
}

export default function SubjectFolder() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const uid = useUid();
  const router = useRouter();
  const db = getDb();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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
      await deleteMaterial(uid, subjectId, document.id, document.r2FileKey || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoving(null);
    }
  }

  /**
   * Presigned URLs expire, so the link is minted on demand rather than stored.
   * A configured public bucket base short-circuits this inside getR2FileUrl.
   */
  async function openOriginal(document: SourceDocument) {
    setError(null);
    try {
      const url = document.r2FileKey ? await getR2FileUrl(document.r2FileKey) : document.r2FileUrl;
      if (!url) throw new Error('This document has no stored original.');
      await Linking.openURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeSubject() {
    setError(null);
    try {
      // A missing object must not block removing the Firestore records.
      await Promise.all(
        documents.data.map((document) =>
          document.r2FileKey ? deleteR2File(document.r2FileKey).catch(() => undefined) : Promise.resolve()
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
          totalChars > 0 ? `${formatChars(totalChars)} of context` : null,
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
        <Button
          label="Add material"
          icon="upload-cloud"
          variant="secondary"
          size="sm"
          onPress={() => setAddOpen(true)}
          className="self-start"
        />
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
                              ? formatChars(document.charCount)
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
                        {document.r2FileKey || document.r2FileUrl ? (
                          <IconButton
                            icon="download"
                            label={`Open ${document.fileName}`}
                            onPress={() => void openOriginal(document)}
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

      <AddMaterialModal
        subjectId={subjectId}
        subjectName={subject.data.name}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
      />
    </ScreenScroll>
  );
}
