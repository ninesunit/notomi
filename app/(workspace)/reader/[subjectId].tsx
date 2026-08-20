import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { AudioOverview } from '@/components/AudioOverview';
import { FileDropZone } from '@/components/FileDropZone';
import { Markdown } from '@/components/Markdown';
import { RichText } from '@/components/RichText';
import { Sheet } from '@/components/Sheet';
import { Badge, Button, EmptyState, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import {
  askSources,
  buildContext,
  generateChatStudyGuide,
  MAX_CONTEXT_CHARS,
  type ChatTurn,
} from '@/lib/ai';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { ChatMessage, SourceDocument, Subject } from '@/lib/schema';
import { exportMarkdown, exportPdf, exportText } from '@/services/documentExport';
import { extractText } from '@/services/fileProcessor';
import type { MaterialFile } from '@/services/ingestion';

const STARTERS = [
  'Summarise the key concepts across all my sources.',
  'What is most likely to come up in the exam?',
  'Explain the hardest idea here in plain language.',
  'Build me a study plan from these notes.',
];

export default function Reader({ parentHref }: { parentHref?: string } = {}) {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const uid = useUid();
  const db = getDb();

  const subject = useDocument<Subject>(paths.subject(db, uid, subjectId), [uid, subjectId]);
  const documents = useCollection<SourceDocument>(
    query(paths.documents(db, uid, subjectId), orderBy('createdAt', 'asc')),
    [uid, subjectId]
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const [attachments, setAttachments] = useState<{ title: string; text: string }[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [generatingGuide, setGeneratingGuide] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  /**
   * Task 4: no RAG, no chunking. Every source for this subject is concatenated
   * and handed to Gemini whole, which is what makes cross-document answers work.
   */
  const context = useMemo(
    () =>
      buildContext(
        [
          ...documents.data.map((document) => ({
            title: document.fileName || document.title,
            text: document.rawText ?? '',
          })),
          ...attachments,
        ]
      ),
    [documents.data, attachments]
  );

  const truncated = useMemo(
    () =>
      documents.data.reduce((total, d) => total + (d.charCount ?? 0), 0) +
        attachments.reduce((total, attachment) => total + attachment.text.length, 0) >
      MAX_CONTEXT_CHARS,
    [documents.data, attachments]
  );

  const sourceSummary = useMemo(
    () =>
      [
        ...documents.data.map(
          (document) => `${document.title}: ${document.summary || document.notes || document.rawText.slice(0, 4_000)}`
        ),
        ...attachments.map((attachment) => `${attachment.title}: ${attachment.text.slice(0, 4_000)}`),
      ].join('\n\n'),
    [documents.data, attachments]
  );

  useEffect(() => {
    if (messages.length) scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || thinking || !context) return;

      const history: ChatTurn[] = messages
        .filter((message) => !message.error && !message.pending)
        .map((message) => ({ role: message.role, text: message.text }))
        .slice(-20);

      const userMessage: ChatMessage = { id: `u${Date.now()}`, role: 'user', text: trimmed };
      const pendingId = `m${Date.now()}`;
      setMessages((previous) => [
        ...previous,
        userMessage,
        { id: pendingId, role: 'model', text: '', pending: true },
      ]);
      setDraft('');
      setThinking(true);

      try {
        const requestsGuide =
          /(?:turn|convert|make|create|export).*(?:chat|conversation).*(?:study guide|notes|pdf)|(?:study guide|notes).*(?:from|out of).*(?:chat|conversation)/i.test(
            trimmed
          );
        let answer: string;
        if (requestsGuide) {
          setGeneratingGuide(true);
          const generated = await generateChatStudyGuide({
            subjectName: subject.data?.name ?? 'Study guide',
            sourceSummary,
            messages: [...history, { role: 'user' as const, text: trimmed }].slice(-20),
          });
          setGuide(generated);
          setGeneratingGuide(false);
          answer = 'Your study guide is ready. Choose Markdown, Text, or PDF in the export panel.';
        } else {
          answer = await askSources(context, history, trimmed);
        }
        setMessages((previous) =>
          previous.map((message) =>
            message.id === pendingId ? { ...message, text: answer, pending: false } : message
          )
        );
      } catch (error) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === pendingId
              ? {
                  ...message,
                  pending: false,
                  error: true,
                  text: error instanceof Error ? error.message : String(error),
                }
              : message
          )
        );
      } finally {
        setGeneratingGuide(false);
        setThinking(false);
      }
    },
    [context, messages, sourceSummary, subject.data?.name, thinking]
  );

  const attach = useCallback(async (files: MaterialFile[]) => {
    setAttaching(true);
    setAttachmentError(null);
    try {
      const parsed: { title: string; text: string }[] = [];
      for (const file of files) {
        const bytes = file.file
          ? await file.file.arrayBuffer()
          : await (await fetch(file.uri)).arrayBuffer();
        const result = await extractText(bytes, file.name, file.mimeType ?? '');
        parsed.push({ title: file.name, text: result.text });
      }
      setAttachments((current) => [...current, ...parsed]);
      setShowAttachments(false);
      setShowSources(true);
    } catch (caught) {
      setAttachmentError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAttaching(false);
    }
  }, []);

  const createGuide = useCallback(async () => {
    setGeneratingGuide(true);
    setExportError(null);
    try {
      const history: ChatTurn[] = messages
        .filter((message) => !message.error && !message.pending)
        .map((message) => ({ role: message.role, text: message.text }))
        .slice(-20);
      setGuide(
        await generateChatStudyGuide({
          subjectName: subject.data?.name ?? 'Study guide',
          sourceSummary,
          messages: history,
        })
      );
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGeneratingGuide(false);
    }
  }, [messages, sourceSummary, subject.data?.name]);

  if (subject.loading || documents.loading) {
    return (
      <View className="flex-1 bg-paper">
        <Loading label="Loading your sources…" />
      </View>
    );
  }

  if (!context) {
    return (
      <View className="flex-1 bg-paper px-6 py-8">
        <View className="mx-auto w-full gap-5" style={{ maxWidth: 880 }}>
          <EmptyState
            icon="file-text"
            title="Nothing to read yet"
            body="Attach a PDF, image or slide deck to this chat, or add a lasting copy to the subject Library."
            action={
              <Link href={parentHref ?? `/library/${subjectId}`} asChild>
                <Button label="Open subject" variant="secondary" />
              </Link>
            }
          />
          {attachmentError ? <Notice title="Could not attach that file" body={attachmentError} /> : null}
          <FileDropZone
            busy={attaching}
            title="Attach files to Open Reader"
            body="Drop PDFs, images or slide decks for this chat session. Up to 10 files and 25 MB total."
            onFiles={attach}
          />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-paper"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Fixed header. The shell clips overflow, so only the list below scrolls. */}
      <View className="shrink-0 border-b border-line bg-paper px-5 py-4 md:px-8">
        <View className="mx-auto w-full flex-row items-center gap-3" style={{ maxWidth: 880 }}>
          <Link href={parentHref ?? `/library/${subjectId}`} asChild>
            <Pressable accessibilityLabel="Back to subject" className="flex-row items-center gap-2 rounded-lg bg-sand px-3 py-2">
              <Icon name="arrow-left" size={16} tone="muted" />
              <Text className="text-xs font-semibold text-muted">Back</Text>
            </Pressable>
          </Link>

          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
              {subject.data?.name ?? 'Open Reader'}
            </Text>
            <Pressable onPress={() => setShowSources((value) => !value)}>
              <Text className="text-xs text-muted">
                Grounded in {documents.data.length + attachments.length}{' '}
                {documents.data.length + attachments.length === 1 ? 'source' : 'sources'} ·{' '}
                {showSources ? 'hide' : 'show'}
              </Text>
            </Pressable>
          </View>

          <Pressable
            accessibilityLabel="Attach files to this chat"
            onPress={() => setShowAttachments((value) => !value)}
            className={`h-9 w-9 items-center justify-center rounded-lg ${showAttachments ? 'bg-accent-soft' : ''}`}
          >
            <Icon name="paperclip" size={15} tone={showAttachments ? 'accent' : 'muted'} />
          </Pressable>

          {messages.length > 0 ? (
            <Pressable
              accessibilityLabel="Create study guide from chat"
              disabled={generatingGuide}
              onPress={() => void createGuide()}
              className="h-9 w-9 items-center justify-center rounded-lg"
            >
              <Icon name="file-down" size={15} tone="muted" />
            </Pressable>
          ) : null}

          {messages.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear conversation"
              onPress={() => setMessages([])}
              className="h-9 w-9 items-center justify-center rounded-lg"
            >
              <Icon name="refresh-cw" size={15} tone="muted" />
            </Pressable>
          ) : null}
        </View>

        {showSources ? (
          <View className="mx-auto mt-3 w-full flex-row flex-wrap gap-2" style={{ maxWidth: 880 }}>
            {documents.data.map((document) => (
              <Badge key={document.id} label={document.fileName} tone="neutral" />
            ))}
            {attachments.map((attachment) => (
              <Badge key={attachment.title} label={`${attachment.title} · chat attachment`} tone="accent" />
            ))}
          </View>
        ) : null}

        {showAttachments ? (
          <View className="mx-auto mt-3 w-full gap-2" style={{ maxWidth: 880 }}>
            {attachmentError ? <Notice title="Could not attach that file" body={attachmentError} /> : null}
            <FileDropZone
              busy={attaching}
              title="Attach files to this chat"
              body="Drop PDFs, images or slide decks. They stay in this active Reader session unless you upload them to the Library separately."
              onFiles={attach}
            />
          </View>
        ) : null}
      </View>

      <ScrollView
        ref={scrollRef}
        className={`flex-1 ${Platform.OS === 'web' ? 'overflow-y-auto' : ''}`}
        contentContainerClassName="px-5 py-6 md:px-8"
        keyboardShouldPersistTaps="handled"
      >
        <View className="mx-auto w-full gap-5" style={{ maxWidth: 880 }}>
          {truncated ? (
            <Notice
              tone="amber"
              title="Very large library"
              body="These sources exceed the context budget, so the middle of the longest documents is trimmed. Answers still cover every source."
            />
          ) : null}

          <AudioOverview context={context} subjectName={subject.data?.name ?? 'this subject'} />

          {messages.length > 0 ? (
            <View className="flex-row justify-end">
              <Button
                label={generatingGuide ? 'Creating guide…' : 'Turn chat into study guide'}
                icon="file-down"
                variant="secondary"
                size="sm"
                loading={generatingGuide}
                onPress={() => void createGuide()}
              />
            </View>
          ) : null}

          {messages.length === 0 ? (
            <View className="gap-3">
              <Text className="text-sm font-semibold text-muted">Ask anything about your sources</Text>
              <View className="flex-row flex-wrap gap-2">
                {STARTERS.map((starter) => (
                  <Pressable
                    key={starter}
                    onPress={() => void send(starter)}
                    className="rounded-xl border border-line bg-surface px-3.5 py-2.5"
                  >
                    <Text className="text-sm text-ink/80">{starter}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            <View className="gap-5">
              {messages.map((message) =>
                message.role === 'user' ? (
                  <View key={message.id} className="items-end">
                    <View className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-3">
                      <Text className="text-[15px] leading-6 text-paper">{message.text}</Text>
                    </View>
                  </View>
                ) : (
                  <View key={message.id} className="flex-row gap-3">
                    <View className="mt-0.5 h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
                      <Text className="text-xs font-bold text-accent">N</Text>
                    </View>
                    <View className="flex-1">
                      {message.pending ? (
                        <Text className="py-1 text-[15px] text-subtle">Reading your sources…</Text>
                      ) : message.error ? (
                        <Notice title="Notomi could not answer that" body={message.text} />
                      ) : (
                        <RichText text={message.text} />
                      )}
                    </View>
                  </View>
                )
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Composer stays pinned; it is a flex sibling, not an absolute overlay. */}
      <View className="shrink-0 border-t border-line bg-paper px-5 py-4 md:px-8">
        <View
          className="mx-auto w-full flex-row items-end gap-2 rounded-2xl border border-line bg-surface p-2"
          style={{ maxWidth: 880 }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask about your sources…"
            placeholderTextColor="#9A9488"
            multiline
            className="max-h-32 flex-1 px-3 py-2.5 text-[15px] text-ink"
            onSubmitEditing={() => void send(draft)}
            blurOnSubmit={false}
            editable={!thinking}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!draft.trim() || thinking}
            onPress={() => void send(draft)}
            className={`h-10 w-10 items-center justify-center rounded-xl ${
              draft.trim() && !thinking ? 'bg-ink' : 'bg-sand'
            }`}
          >
            <Icon name="arrow-up" size={17} tone={draft.trim() && !thinking ? 'inverse' : 'subtle'} />
          </Pressable>
        </View>
        <Text className="mx-auto mt-2 w-full text-center text-xs text-subtle" style={{ maxWidth: 880 }}>
          Answers are drawn only from your uploaded sources, with inline quotes.
        </Text>
      </View>

      <Sheet
        visible={guide !== null || generatingGuide || exportError !== null}
        onClose={() => {
          if (generatingGuide) return;
          setGuide(null);
          setExportError(null);
        }}
        title="AI study guide"
        icon="file-down"
        maxHeight={720}
        footer={
          guide ? (
            <>
              <Button label="Markdown" icon="download" variant="secondary" size="sm" onPress={() => exportMarkdown(`${subject.data?.name ?? 'Notomi'} study guide`, guide)} />
              <Button label="Text" icon="download" variant="secondary" size="sm" onPress={() => exportText(`${subject.data?.name ?? 'Notomi'} study guide`, guide)} />
              <Button
                label="PDF"
                icon="file-down"
                size="sm"
                onPress={() =>
                  void exportPdf(`${subject.data?.name ?? 'Notomi'} study guide`, guide).catch((caught) =>
                    setExportError(caught instanceof Error ? caught.message : String(caught))
                  )
                }
              />
            </>
          ) : undefined
        }
      >
        {exportError ? <Notice title="Could not create the study guide" body={exportError} /> : null}
        {generatingGuide ? <Loading label="Writing a grounded two-page guide…" /> : guide ? <Markdown source={guide} /> : null}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
