import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { limit, orderBy, query } from 'firebase/firestore';
import { Markdown } from './Markdown';
import { IconButton, Notice } from './ui';
import { useCollection } from '@/hooks/useFirestore';
import { askSources, buildContext, type ChatTurn } from '@/lib/ai';
import { formatRelative } from '@/lib/dates';
import { paths } from '@/lib/paths';
import type { ChatRecord, ChatSession } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  appendMessage,
  clearChat,
  createChat,
  deleteChat,
  titleFromFirstMessage,
} from '@/services/chat';

/**
 * The sidebar assistant.
 *
 * Grounded in whatever text it is handed — one document in the reader, every
 * source in a subject elsewhere — and backed by Firestore so a thread survives
 * a refresh. History is a dropdown rather than a second pane: the sidebar is
 * already narrow.
 */

const STARTERS = [
  'Explain the hardest concept here simply.',
  'What would an exam ask about this?',
  'Give me a worked example.',
];

export function DocumentChat({
  uid,
  subjectId,
  documentId,
  sources,
  heading,
}: {
  uid: string;
  subjectId: string;
  /** Scopes threads to one document; null keeps them at subject level. */
  documentId: string | null;
  sources: { title: string; text: string }[];
  heading: string;
}) {
  const db = getDb();
  const [chatId, setChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const chats = useCollection<ChatSession>(
    query(paths.chats(db, uid, subjectId), orderBy('updatedAt', 'desc'), limit(30)),
    [uid, subjectId]
  );

  // Threads for this document only; a subject-level panel sees all of them.
  const relevant = useMemo(
    () =>
      documentId === null
        ? chats.data
        : chats.data.filter((chat) => chat.documentId === documentId),
    [chats.data, documentId]
  );

  // Resume the most recent thread rather than opening a blank one on every
  // visit — the point of persisting history is not having to scroll back.
  //
  // Strictly once, on the first load: re-running whenever chatId is null would
  // pull the newest thread straight back and make "New conversation" a no-op.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (resumed || chatId || chats.loading) return;
    setResumed(true);
    if (relevant.length > 0) setChatId(relevant[0].id);
  }, [resumed, chatId, chats.loading, relevant]);

  const messages = useCollection<ChatRecord>(
    chatId ? query(paths.chatMessages(db, uid, subjectId, chatId), orderBy('createdAt', 'asc')) : null,
    [uid, subjectId, chatId]
  );

  const context = useMemo(() => buildContext(sources), [sources]);
  const active = relevant.find((chat) => chat.id === chatId) ?? null;

  useEffect(() => {
    if (messages.data.length || pending) {
      // A frame's delay lets the new bubble lay out before we scroll past it.
      const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
      return () => clearTimeout(timer);
    }
  }, [messages.data.length, pending]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || thinking) return;

      if (!context) {
        setError('There is no readable text to ground an answer in yet.');
        return;
      }

      setError(null);
      setDraft('');
      setPending(trimmed);
      setThinking(true);

      try {
        const id = chatId ?? (await createChat(uid, subjectId, { documentId }));
        if (!chatId) setChatId(id);

        const history: ChatTurn[] = messages.data
          .map((message): ChatTurn => ({
            role: message.sender === 'ai' ? 'model' : 'user',
            text: message.text,
          }))
          .slice(-20);

        await appendMessage(uid, subjectId, id, 'user', trimmed);
        if (history.length === 0) await titleFromFirstMessage(uid, subjectId, id, trimmed);

        const answer = await askSources(context, history, trimmed);
        await appendMessage(uid, subjectId, id, 'ai', answer);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        // Put the question back so it is not lost to a transient failure.
        setDraft(trimmed);
      } finally {
        setPending(null);
        setThinking(false);
      }
    },
    [chatId, context, documentId, messages.data, subjectId, thinking, uid]
  );

  const startNew = useCallback(() => {
    setChatId(null);
    setHistoryOpen(false);
    setError(null);
  }, []);

  const wipe = useCallback(async () => {
    if (!chatId) return;
    setError(null);
    try {
      await clearChat(uid, subjectId, chatId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [chatId, subjectId, uid]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteChat(uid, subjectId, id);
        if (id === chatId) setChatId(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [chatId, subjectId, uid]
  );

  const empty = messages.data.length === 0 && !pending;

  return (
    <View className="min-h-0 flex-1">
      <View className="flex-row items-center gap-2 border-b border-line px-3 py-2.5">
        <View className="h-7 w-7 items-center justify-center rounded-lg bg-accent-soft">
          <Icon name="message-circle" size={13} color="#B4552D" />
        </View>
        <View className="flex-1">
          <Text className="text-[13px] font-semibold text-ink" numberOfLines={1}>
            {active?.title ?? heading}
          </Text>
          <Text className="text-[11px] text-subtle" numberOfLines={1}>
            {active ? `${messages.data.length} messages` : 'Grounded in this material'}
          </Text>
        </View>

        <IconButton
          icon="clock"
          label="Chat history"
          onPress={() => setHistoryOpen((open) => !open)}
        />
        <IconButton icon="edit" label="New conversation" onPress={startNew} />
        {chatId && messages.data.length > 0 ? (
          <IconButton icon="trash-2" tone="rose" label="Clear this conversation" onPress={() => void wipe()} />
        ) : null}
      </View>

      {historyOpen ? (
        <View className="max-h-56 border-b border-line bg-sand/50">
          <ScrollView contentContainerClassName="gap-1 p-2">
            {relevant.length === 0 ? (
              <Text className="px-2 py-3 text-xs text-muted">No saved conversations yet.</Text>
            ) : (
              relevant.map((chat) => (
                <View
                  key={chat.id}
                  className={`flex-row items-center gap-1 rounded-lg ${
                    chat.id === chatId ? 'bg-surface' : ''
                  }`}
                >
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setChatId(chat.id);
                      setHistoryOpen(false);
                    }}
                    className="flex-1 px-2.5 py-2"
                  >
                    <Text className="text-xs font-medium text-ink" numberOfLines={1}>
                      {chat.title}
                    </Text>
                    <Text className="text-[11px] text-subtle">
                      {[
                        `${chat.messageCount ?? 0} messages`,
                        formatRelative(chat.updatedAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </Pressable>
                  <IconButton
                    icon="x"
                    tone="rose"
                    label={`Delete ${chat.title}`}
                    onPress={() => void remove(chat.id)}
                  />
                </View>
              ))
            )}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView ref={scrollRef} className="min-h-0 flex-1" contentContainerClassName="gap-3 p-3">
        {empty ? (
          <View className="gap-2 pt-2">
            <Text className="text-xs leading-5 text-muted">
              Ask anything about this material. Answers come only from what you uploaded.
            </Text>
            {STARTERS.map((starter) => (
              <Pressable
                key={starter}
                accessibilityRole="button"
                onPress={() => void send(starter)}
                className="rounded-xl border border-line bg-surface px-3 py-2.5"
              >
                <Text className="text-xs leading-5 text-ink/80">{starter}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {messages.data.map((message) => (
          <Bubble key={message.id} sender={message.sender} text={message.text} />
        ))}

        {pending ? <Bubble sender="user" text={pending} /> : null}

        {thinking ? (
          <View className="flex-row items-center gap-2 self-start rounded-2xl bg-sand px-3 py-2.5">
            <ActivityIndicator size="small" color="#B4552D" />
            <Text className="text-xs text-muted">Reading your material…</Text>
          </View>
        ) : null}

        {error ? <Notice title="Could not answer that" body={error} /> : null}
      </ScrollView>

      <View className="flex-row items-end gap-2 border-t border-line p-2.5">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask about this material…"
          placeholderTextColor="#9A9488"
          multiline
          onSubmitEditing={() => void send(draft)}
          blurOnSubmit
          className="max-h-28 min-h-[40px] flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] text-ink"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={thinking || !draft.trim()}
          onPress={() => void send(draft)}
          className={`h-10 w-10 items-center justify-center rounded-xl bg-ink ${
            thinking || !draft.trim() ? 'opacity-40' : ''
          }`}
        >
          <Icon name="arrow-up" size={16} color="#F7F5EE" />
        </Pressable>
      </View>
    </View>
  );
}

function Bubble({ sender, text }: { sender: ChatRecord['sender']; text: string }) {
  if (sender === 'user') {
    return (
      <View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-ink px-3 py-2.5">
        <Text className="text-[13px] leading-5 text-paper">{text}</Text>
      </View>
    );
  }

  // Gemini answers in Markdown; rendering it is what makes lists and tables in
  // an explanation readable in a narrow column.
  return (
    <View className="max-w-full self-start rounded-2xl rounded-bl-md bg-sand px-3 py-2.5">
      <Markdown source={text} />
    </View>
  );
}
