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
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { AudioOverview } from '@/components/AudioOverview';
import { RichText } from '@/components/RichText';
import { Badge, Button, EmptyState, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { askSources, buildContext, MAX_CONTEXT_CHARS, type ChatTurn } from '@/lib/ai';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { ChatMessage, SourceDocument, Subject } from '@/lib/schema';

const STARTERS = [
  'Summarise the key concepts across all my sources.',
  'What is most likely to come up in the exam?',
  'Explain the hardest idea here in plain language.',
  'Build me a study plan from these notes.',
];

export default function Reader() {
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
  const scrollRef = useRef<ScrollView>(null);

  /**
   * Task 4: no RAG, no chunking. Every source for this subject is concatenated
   * and handed to Gemini whole, which is what makes cross-document answers work.
   */
  const context = useMemo(
    () =>
      buildContext(
        documents.data.map((document) => ({
          title: document.fileName || document.title,
          text: document.rawText ?? '',
        }))
      ),
    [documents.data]
  );

  const truncated = useMemo(
    () => documents.data.reduce((total, d) => total + (d.charCount ?? 0), 0) > MAX_CONTEXT_CHARS,
    [documents.data]
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
        .map((message) => ({ role: message.role, text: message.text }));

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
        const answer = await askSources(context, history, trimmed);
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
        setThinking(false);
      }
    },
    [context, messages, thinking]
  );

  if (subject.loading || documents.loading) {
    return (
      <View className="flex-1 bg-paper">
        <Loading label="Loading your sources…" />
      </View>
    );
  }

  if (!context) {
    return (
      <View className="flex-1 justify-center bg-paper px-6">
        <EmptyState
          icon="file-text"
          title="Nothing to read yet"
          body="Add at least one document with readable text to this subject, then Notomi can answer questions about it."
          action={
            <Link href={`/library/${subjectId}`} asChild>
              <Button label="Open subject" variant="secondary" />
            </Link>
          }
        />
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
          <Link href={`/library/${subjectId}`} asChild>
            <Pressable className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
              <Feather name="chevron-left" size={16} color="#6F6A5F" />
            </Pressable>
          </Link>

          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
              {subject.data?.name ?? 'Reader'}
            </Text>
            <Pressable onPress={() => setShowSources((value) => !value)}>
              <Text className="text-xs text-muted">
                Grounded in {documents.data.length}{' '}
                {documents.data.length === 1 ? 'source' : 'sources'} ·{' '}
                {showSources ? 'hide' : 'show'}
              </Text>
            </Pressable>
          </View>

          {messages.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear conversation"
              onPress={() => setMessages([])}
              className="h-9 w-9 items-center justify-center rounded-lg"
            >
              <Feather name="refresh-cw" size={15} color="#6F6A5F" />
            </Pressable>
          ) : null}
        </View>

        {showSources ? (
          <View className="mx-auto mt-3 w-full flex-row flex-wrap gap-2" style={{ maxWidth: 880 }}>
            {documents.data.map((document) => (
              <Badge key={document.id} label={document.fileName} tone="neutral" />
            ))}
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
            <Feather name="arrow-up" size={17} color={draft.trim() && !thinking ? '#F7F5EE' : '#9A9488'} />
          </Pressable>
        </View>
        <Text className="mx-auto mt-2 w-full text-center text-xs text-subtle" style={{ maxWidth: 880 }}>
          Answers are drawn only from your uploaded sources, with inline quotes.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}
