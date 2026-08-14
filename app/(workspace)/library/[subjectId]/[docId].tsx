import { useCallback, useMemo, useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/Icon';
import { serverTimestamp, updateDoc } from 'firebase/firestore';
import { DocumentChat } from '@/components/DocumentChat';
import { ListenBar } from '@/components/ListenBar';
import { Markdown } from '@/components/Markdown';
import { Badge, Button, Card, IconButton, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useDocument } from '@/hooks/useFirestore';
import { formatDateTime } from '@/lib/dates';
import { formatChars } from '@/lib/format';
import { paths } from '@/lib/paths';
import type { FileKind, SourceDocument, Subject } from '@/lib/schema';
import { generateNotes } from '@/services/aiNotes';
import { getDb } from '@/services/firebase';
import { getR2FileUrl } from '@/services/r2Storage';

/**
 * The note reader: full study notes on the left, a grounded assistant on the
 * right.
 *
 * The sidebar is a docked panel on a wide screen and a sheet on a narrow one —
 * a 320px column beside prose is unreadable on a phone.
 */

const SIDEBAR_BREAKPOINT = 1100;

const KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'Slide deck',
  text: 'Text',
  image: 'Image · read with OCR',
  audio: 'Audio · transcribed',
  video: 'Video · transcribed',
};

export default function DocumentReader({ basePath = '/library' }: { basePath?: string } = {}) {
  const { subjectId, docId, page, highlight } = useLocalSearchParams<{
    subjectId: string;
    docId: string;
    page?: string;
    highlight?: string;
  }>();
  const uid = useUid();
  const db = getDb();
  const { width } = useWindowDimensions();

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const subject = useDocument<Subject>(paths.subject(db, uid, subjectId), [uid, subjectId]);
  const document = useDocument<SourceDocument>(
    paths.document(db, uid, subjectId, docId),
    [uid, subjectId, docId]
  );

  const wide = width >= SIDEBAR_BREAKPOINT;
  const record = document.data;
  const sourcePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.round(Number(page)) : null;
  const sourceHighlight = typeof highlight === 'string' ? highlight.trim() : '';

  const sources = useMemo(
    () =>
      record
        ? [{ title: record.fileName || record.title, text: record.rawText ?? '' }]
        : [],
    [record]
  );

  const write = useCallback(async () => {
    if (!record) return;
    setError(null);
    setGenerating(true);
    try {
      const notes = await generateNotes(record.title || record.fileName, record.rawText ?? '');
      await updateDoc(paths.document(db, uid, subjectId, docId), {
        notes,
        notesGeneratedAt: serverTimestamp(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGenerating(false);
    }
  }, [record, db, uid, subjectId, docId]);

  const openOriginal = useCallback(async () => {
    if (!record) return;
    setError(null);
    // Safari blocks window.open when it happens after an awaited fetch. Open
    // the harmless target synchronously from the tap, then navigate it once
    // the authenticated R2 download has become a local object URL.
    const pendingWindow =
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? window.open('about:blank', '_blank')
        : null;
    if (pendingWindow) pendingWindow.opener = null;
    try {
      const url = record.r2FileKey ? await getR2FileUrl(record.r2FileKey) : record.r2FileUrl;
      if (!url) throw new Error('This document has no stored original.');
      const target = sourcePage ? `${url}#page=${sourcePage}` : url;
      if (pendingWindow) pendingWindow.location.href = target;
      else await Linking.openURL(target);
    } catch (caught) {
      pendingWindow?.close();
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [record, sourcePage]);

  if (document.loading) {
    return (
      <View className="flex-1">
        <Loading label="Opening document…" />
      </View>
    );
  }

  if (!record) {
    return (
      <ScrollView contentContainerClassName="px-5 py-7 md:px-10 md:py-10">
        <Notice
          title="Document not found"
          body="It may have been removed from this subject."
        />
        <View className="mt-5 items-start">
          <Link href={`${basePath}/${subjectId}`} asChild>
            <Button label="Back to subject" variant="secondary" size="sm" />
          </Link>
        </View>
      </ScrollView>
    );
  }

  const hasText = (record.rawText ?? '').trim().length > 0;

  const panel = (
    <DocumentChat
      uid={uid}
      subjectId={subjectId}
      documentId={docId}
      sources={sources}
      heading="Ask about this document"
    />
  );

  return (
    <View className="min-h-0 flex-1 flex-row">
      <ScrollView
        className="min-h-0 flex-1"
        contentContainerClassName="px-5 py-7 md:px-10 md:py-10"
      >
        <View className="mx-auto w-full" style={{ maxWidth: 820 }}>
          <Link href={`${basePath}/${subjectId}`} asChild>
            <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
              <Icon name="arrow-left" size={15} color="#6F6A5F" />
              <Text className="text-sm font-medium text-muted">
                Back to {subject.data?.name ?? 'Subject'}
              </Text>
            </Pressable>
          </Link>

          <View className="mb-6 gap-3">
            <Text className="text-[30px] font-bold leading-9 tracking-tight text-ink">
              {record.title || record.fileName}
            </Text>

            <View className="flex-row flex-wrap items-center gap-2">
              <Badge label={KIND_LABEL[record.sourceKind] ?? 'Document'} />
              {record.moduleCode ? <Badge label={record.moduleCode} tone="accent" /> : null}
              {record.notes ? <Badge label="Notes ready" tone="pine" /> : null}
              <Text className="text-xs text-subtle">
                {[
                  formatDateTime(record.createdAt),
                  record.charCount ? formatChars(record.charCount) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>

            <View className="flex-row flex-wrap items-center gap-2">
              <Button
                label={
                  generating
                    ? 'Writing notes…'
                    : record.notes
                      ? 'Regenerate notes'
                      : 'Generate study notes'
                }
                icon="feather"
                size="sm"
                loading={generating}
                disabled={generating || !hasText}
                onPress={() => void write()}
              />
              {!wide ? (
                <Button
                  label="Ask AI"
                  icon="message-circle"
                  variant="secondary"
                  size="sm"
                  onPress={() => setChatOpen(true)}
                />
              ) : null}
              {record.r2FileKey || record.r2FileUrl ? (
                <Button
                  label={sourcePage ? `Open page ${sourcePage}` : 'Open original'}
                  icon="external-link"
                  variant="secondary"
                  size="sm"
                  onPress={() => void openOriginal()}
                />
              ) : null}
            </View>
          </View>

          {error ? (
            <View className="mb-6">
              <Notice title="Something went wrong" body={error} />
            </View>
          ) : null}

          {sourcePage || sourceHighlight ? (
            <View className="mb-6 gap-3 rounded-2xl border border-amber/30 bg-amber-soft/40 p-4">
              <View className="flex-row items-center gap-2">
                <Icon name="external-link" size={15} color="#B4832A" />
                <Text className="text-sm font-semibold text-ink">
                  From Notomi Reel{sourcePage ? ` · Page ${sourcePage}` : ''}
                </Text>
              </View>
              {sourceHighlight ? (
                <Text className="text-sm leading-6 text-ink" selectable>
                  {sourceHighlight}
                </Text>
              ) : null}
              {record.r2FileKey || record.r2FileUrl ? (
                <View className="items-start">
                  <Button
                    label={sourcePage ? `Open original at page ${sourcePage}` : 'Open original'}
                    icon="external-link"
                    variant="secondary"
                    size="sm"
                    onPress={() => void openOriginal()}
                  />
                </View>
              ) : null}
            </View>
          ) : null}

          {!hasText ? (
            <Notice
              tone="amber"
              title="No text was extracted"
              body="Notomi could not read any text from this file, so notes and chat have nothing to work from."
            />
          ) : record.notes ? (
            <>
              <View className="mb-5">
                <ListenBar markdown={record.notes} />
              </View>

              <Card className="mb-6 gap-4">
                <Markdown source={record.notes} />
              </Card>
              <Text className="mb-8 text-xs text-subtle">
                Generated {formatDateTime(record.notesGeneratedAt)} from this document only.
                Regenerate if you replace the source.
              </Text>
            </>
          ) : (
            <Card className="mb-6 items-start gap-3">
              <View className="h-10 w-10 items-center justify-center rounded-full bg-accent-soft">
                <Icon name="feather" size={17} color="#B4552D" />
              </View>
              <Text className="text-base font-semibold text-ink">No notes yet</Text>
              <Text className="text-sm leading-6 text-muted">
                {record.summary ??
                  'Notomi can turn this document into full study notes: an overview, a terminology table, a concept-by-concept breakdown, every formula, and self-test questions.'}
              </Text>
              <Button
                label="Generate study notes"
                icon="feather"
                loading={generating}
                disabled={generating}
                onPress={() => void write()}
              />
            </Card>
          )}

          {hasText ? (
            <View className="border-t border-line pt-5">
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowSource((open) => !open)}
                className="flex-row items-center gap-2 self-start py-1"
              >
                <Icon
                  name={showSource ? 'chevron-down' : 'chevron-right'}
                  size={14}
                  color="#6F6A5F"
                />
                <Text className="text-sm font-medium text-muted">
                  {showSource ? 'Hide extracted text' : 'Show extracted text'}
                </Text>
              </Pressable>

              {showSource ? (
                <View className="mt-3 rounded-xl border border-line bg-sand/40 p-4">
                  <Text className="font-mono text-xs leading-5 text-ink/70" selectable>
                    {record.rawText}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>

      {wide ? (
        <View className="min-h-0 w-[360px] border-l border-line bg-surface">{panel}</View>
      ) : (
        <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
          <View className="min-h-0 flex-1 bg-surface">
            <View className="flex-row items-center gap-2 border-b border-line px-3 py-2">
              <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
                {record.title || record.fileName}
              </Text>
              <IconButton icon="x" label="Close chat" onPress={() => setChatOpen(false)} />
            </View>
            {panel}
          </View>
        </Modal>
      )}
    </View>
  );
}
