import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { ShareMaterial } from '@/components/social/ShareMaterial';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader, Touchable } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { formatRelative, toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  conversationIdFor,
  markConversationRead,
  otherMember,
  sendFriendMessage,
  type ConversationMember,
  type ConversationRead,
  type MessageAttachment,
  type SocialConversation,
  type SocialMessage,
} from '@/services/socialMessaging';
import {
  friendsPath,
  profilePath,
  type Friend,
  type Profile,
} from '@/services/social';
import {
  updateSocialInboxItem,
  type SocialInboxItem,
} from '@/services/socialInbox';
import {
  openOrJoinCircle,
  sendCirclePost,
  type CirclePost,
  type StudyCircle,
} from '@/services/studyCircles';

type MessagesView = 'chats' | 'inbox' | 'circles';

const VIEWS: { id: MessagesView; label: string; icon: IconName }[] = [
  { id: 'chats', label: 'Chats', icon: 'message-circle' },
  { id: 'inbox', label: 'Inbox', icon: 'bell' },
  { id: 'circles', label: 'Course circles', icon: 'users-round' },
];

export function Messages({
  initialConversationId,
  initialRecipientId,
}: {
  initialConversationId?: string;
  initialRecipientId?: string;
} = {}) {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();
  const { width } = useWindowDimensions();
  const desktop = width >= 820;
  const [view, setView] = useState<MessagesView>('chats');
  const profile = useDocument<Profile>(profilePath(db, uid), [uid]);
  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const conversations = useCollection<SocialConversation>(
    query(paths.conversations(db), where('memberIds', 'array-contains', uid), limit(50)),
    [uid]
  );
  const reads = useCollection<ConversationRead>(query(paths.conversationReads(db, uid), limit(100)), [uid]);
  const [recipient, setRecipient] = useState<ConversationMember | null>(null);
  const [conversationExists, setConversationExists] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const me = useMemo<ConversationMember>(
    () => ({
      id: uid,
      displayName: profile.data?.displayName || user?.displayName || user?.email?.split('@')[0] || 'Student',
      username: profile.data?.username || '',
      color: profile.data?.color || '#B4552D',
    }),
    [uid, profile.data, user]
  );
  const ordered = useMemo(
    () => [...conversations.data].sort((left, right) => {
      const a = toDate(left.lastMessageAt)?.getTime() ?? 0;
      const b = toDate(right.lastMessageAt)?.getTime() ?? 0;
      return b - a;
    }),
    [conversations.data]
  );
  const readMap = useMemo(
    () => new Map(reads.data.map((entry) => [entry.id, toDate(entry.lastReadAt)?.getTime() ?? 0])),
    [reads.data]
  );

  useEffect(() => {
    if (!initialConversationId || !conversations.data.length) return;
    const conversation = conversations.data.find((entry) => entry.id === initialConversationId);
    if (!conversation) return;
    const other = otherMember(conversation, uid);
    if (other) {
      setRecipient(other);
      setConversationExists(true);
    }
  }, [initialConversationId, conversations.data, uid]);

  useEffect(() => {
    if (!initialRecipientId || recipient) return;
    const friend = friends.data.find((entry) => entry.id === initialRecipientId && entry.status === 'accepted');
    if (friend) startFriend(friend);
  }, [initialRecipientId, friends.data, recipient]);

  function openConversation(conversation: SocialConversation) {
    const other = otherMember(conversation, uid);
    if (!other) return;
    setRecipient(other);
    setConversationExists(true);
  }

  function startFriend(friend: Friend) {
    const conversationId = conversationIdFor(uid, friend.id);
    const existing = conversations.data.some((entry) => entry.id === conversationId);
    setRecipient({
      id: friend.id,
      displayName: friend.displayName,
      username: friend.username,
      color: friend.color,
    });
    setConversationExists(existing);
    setPickerOpen(false);
  }

  return (
    <View className="min-h-0 flex-1">
      <ScreenScroll maxWidth={1100}>
        <PageHeader
          title="Messages"
          subtitle="Private study conversations with accepted friends."
          actions={<Button label="New message" icon="edit-3" size="sm" onPress={() => setPickerOpen(true)} />}
        />
        <View className="mb-5 flex-row rounded-xl border border-line bg-sand p-1">
          {VIEWS.map((entry) => {
            const active = view === entry.id;
            return (
              <Touchable
                key={entry.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={entry.label}
                onPress={() => setView(entry.id)}
                className={`h-10 flex-1 flex-row items-center justify-center gap-2 rounded-lg ${active ? 'bg-surface' : ''}`}
              >
                <Icon name={entry.icon} size={15} tone={active ? 'ink' : 'muted'} />
                {width >= 560 ? (
                  <Text className={`text-xs font-semibold ${active ? 'text-ink' : 'text-muted'}`}>{entry.label}</Text>
                ) : null}
              </Touchable>
            );
          })}
        </View>

        {view === 'inbox' ? (
          <SocialInbox />
        ) : view === 'circles' ? (
          <CourseCircles me={me} profile={profile.data} />
        ) : (
          <View className={desktop ? 'flex-row items-start gap-5' : ''}>
            <View className="min-w-0 gap-2" style={desktop ? { flex: 1 } : undefined}>
              {conversations.loading ? (
                <Loading label="Loading conversations..." />
              ) : conversations.error ? (
                <Notice title="Could not load messages" body={conversations.error.message} />
              ) : ordered.length === 0 ? (
                <EmptyState
                  icon="message-circle"
                  title="No conversations yet"
                  body="Message an accepted friend or share a read-only study item."
                  action={<Button label="Choose a friend" icon="user-plus" size="sm" onPress={() => setPickerOpen(true)} />}
                />
              ) : (
                ordered.map((conversation) => {
                  const other = otherMember(conversation, uid);
                  if (!other) return null;
                  const lastAt = toDate(conversation.lastMessageAt)?.getTime() ?? 0;
                  const unread = conversation.lastSenderId !== uid && lastAt > (readMap.get(conversation.id) ?? 0);
                  return (
                    <Touchable
                      key={conversation.id}
                      accessibilityRole="button"
                      onPress={() => openConversation(conversation)}
                      className={`flex-row items-center gap-3 rounded-2xl border p-3 ${
                        recipient?.id === other.id && desktop ? 'border-ink bg-sand' : 'border-line bg-surface'
                      }`}
                    >
                      <Avatar name={other.displayName} color={other.color} size={42} />
                      <View className="min-w-0 flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className="min-w-0 flex-1 text-[15px] font-semibold text-ink" numberOfLines={1}>{other.displayName}</Text>
                          <Text className="text-[11px] text-subtle">{formatRelative(conversation.lastMessageAt)}</Text>
                        </View>
                        <Text className={`mt-0.5 text-xs ${unread ? 'font-semibold text-ink' : 'text-muted'}`} numberOfLines={1}>
                          {conversation.lastSenderId === uid ? 'You: ' : ''}{conversation.lastMessage}
                        </Text>
                      </View>
                      {unread ? <View className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
                    </Touchable>
                  );
                })
              )}
            </View>
            {desktop ? (
              <View className="min-w-0" style={{ flex: 1.35 }}>
                {recipient ? (
                  <ConversationThread
                    me={me}
                    recipient={recipient}
                    exists={conversationExists}
                    onCreated={() => setConversationExists(true)}
                  />
                ) : (
                  <Card className="items-center gap-2 py-16">
                    <Icon name="message-circle" size={28} tone="subtle" />
                    <Text className="text-sm text-muted">Choose a conversation.</Text>
                  </Card>
                )}
              </View>
            ) : null}
          </View>
        )}
      </ScreenScroll>

      {!desktop ? (
        <Sheet
          visible={recipient !== null}
          onClose={() => setRecipient(null)}
          title={recipient?.displayName ?? 'Conversation'}
          icon="message-circle"
          variant="fullscreen-mobile"
          dismissOnScrim={false}
        >
          {recipient ? (
            <ConversationThread
              me={me}
              recipient={recipient}
              exists={conversationExists}
              onCreated={() => setConversationExists(true)}
            />
          ) : null}
        </Sheet>
      ) : null}

      <Sheet visible={pickerOpen} onClose={() => setPickerOpen(false)} title="New message" icon="edit-3" variant="compact">
        <View className="gap-2">
          {friends.data.filter((friend) => friend.status === 'accepted').map((friend) => (
            <Touchable key={friend.id} onPress={() => startFriend(friend)} className="flex-row items-center gap-3 rounded-xl px-2 py-3">
              <Avatar name={friend.displayName} color={friend.color} size={36} />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{friend.displayName}</Text>
                <Text className="text-xs text-muted" numberOfLines={1}>@{friend.username || 'student'}</Text>
              </View>
              <Icon name="chevron-right" size={15} tone="subtle" />
            </Touchable>
          ))}
          {!friends.loading && friends.data.every((friend) => friend.status !== 'accepted') ? (
            <Text className="py-4 text-center text-sm text-muted">Add a friend before starting a conversation.</Text>
          ) : null}
        </View>
      </Sheet>
    </View>
  );
}

function ConversationThread({
  me,
  recipient,
  exists,
  onCreated,
}: {
  me: ConversationMember;
  recipient: ConversationMember;
  exists: boolean;
  onCreated: () => void;
}) {
  const id = conversationIdFor(me.id, recipient.id);
  const messages = useCollection<SocialMessage>(
    exists ? query(paths.conversationMessages(getDb(), id), orderBy('createdAt', 'desc'), limit(50)) : null,
    [id, exists]
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const ordered = useMemo(() => [...messages.data].reverse(), [messages.data]);

  useEffect(() => {
    if (!exists) return;
    void markConversationRead(me.id, id).catch(() => undefined);
  }, [exists, id, me.id, messages.data.length]);

  async function send(attachment: MessageAttachment | null = null) {
    if (!text.trim() && !attachment) return;
    setBusy(true);
    setError(null);
    try {
      await sendFriendMessage({ sender: me, recipient, text, attachment });
      setText('');
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const friend: Friend = {
    id: recipient.id,
    displayName: recipient.displayName,
    username: recipient.username,
    color: recipient.color,
    status: 'accepted',
    createdAt: null,
  };

  return (
    <Card className="min-h-[420px] gap-3 p-3">
      <View className="flex-row items-center gap-3 border-b border-line px-1 pb-3">
        <Avatar name={recipient.displayName} color={recipient.color} size={38} />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{recipient.displayName}</Text>
          <Text className="text-xs text-muted" numberOfLines={1}>@{recipient.username || 'student'}</Text>
        </View>
      </View>
      {error ? <Notice title="Could not send that message" body={error} /> : null}
      <ScrollView className="min-h-[220px] max-h-[420px]" contentContainerClassName="gap-2 py-2">
        {!exists ? (
          <Text className="py-10 text-center text-sm text-muted">Start the conversation below.</Text>
        ) : messages.loading ? (
          <Loading label="Loading messages..." />
        ) : ordered.map((message) => {
          const mine = message.senderId === me.id;
          return (
            <View key={message.id} className={`max-w-[86%] gap-1 rounded-2xl px-3 py-2 ${mine ? 'self-end bg-ink' : 'self-start bg-sand'}`}>
              {message.text ? <Text className={`text-sm leading-5 ${mine ? 'text-paper' : 'text-ink'}`}>{message.text}</Text> : null}
              {message.attachment ? (
                <View className={`mt-1 flex-row items-center gap-2 rounded-xl border px-2.5 py-2 ${mine ? 'border-paper/20' : 'border-line bg-surface'}`}>
                  <Icon name="paperclip" size={14} tone={mine ? 'inverse' : 'accent'} />
                  <View className="min-w-0 flex-1">
                    <Text className={`text-xs font-semibold ${mine ? 'text-paper' : 'text-ink'}`} numberOfLines={1}>{message.attachment.title}</Text>
                    <Text className={`text-[11px] ${mine ? 'text-paper/70' : 'text-muted'}`} numberOfLines={1}>{message.attachment.subjectName}</Text>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <View className="flex-row items-end gap-2 border-t border-line pt-3">
        <Pressable accessibilityRole="button" accessibilityLabel="Share a study item" onPress={() => setSharing(true)} className="h-11 w-11 items-center justify-center rounded-xl border border-line">
          <Icon name="paperclip" size={17} tone="muted" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Field
            value={text}
            onChangeText={setText}
            placeholder="Message"
            multiline
            maxLength={2000}
            className="max-h-28"
          />
        </View>
        <Button label="Send" icon="send" size="sm" loading={busy} disabled={!text.trim()} onPress={() => void send()} />
      </View>
      {sharing ? (
        <ShareMaterial
          friend={friend}
          open
          onClose={() => setSharing(false)}
          onShared={(share) => send({
            shareId: share.shareId,
            kind: share.kind,
            title: share.title,
            subjectName: share.subjectName,
          })}
        />
      ) : null}
    </Card>
  );
}

function SocialInbox() {
  const uid = useUid();
  const router = useRouter();
  const inbox = useCollection<SocialInboxItem>(
    query(paths.socialInbox(getDb(), uid), orderBy('createdAt', 'desc'), limit(50)),
    [uid]
  );

  if (inbox.loading) return <Loading label="Loading social inbox..." />;
  if (inbox.error) return <Notice title="Could not load the social inbox" body={inbox.error.message} />;
  if (!inbox.data.length) return <EmptyState icon="bell" title="Inbox is clear" body="Shared study items, schedule proposals, circles and sprint invitations appear here." />;

  return (
    <View className="gap-2">
      {inbox.data.map((item) => (
        <Card key={item.id} className={`gap-2 p-4 ${item.readAt ? '' : 'border-accent/40 bg-accent-soft'}`}>
          <View className="flex-row items-start gap-3">
            <View className="h-9 w-9 items-center justify-center rounded-xl bg-sand">
              <Icon name={inboxIcon(item.type)} size={16} tone="accent" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-ink">{item.title}</Text>
              <Text className="mt-1 text-xs leading-5 text-muted">{item.body}</Text>
              <Text className="mt-1 text-[11px] text-subtle">{formatRelative(item.createdAt)}</Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2 pl-12">
            {item.type === 'availability' && item.status === 'new' ? (
              <>
                <Button label="Accept" icon="check" size="sm" onPress={() => void updateSocialInboxItem(uid, item.id, { status: 'accepted', read: true })} />
                <Button label="Decline" icon="x" variant="ghost" size="sm" onPress={() => void updateSocialInboxItem(uid, item.id, { status: 'declined', read: true })} />
              </>
            ) : item.type === 'share' ? (
              <Button label="Open Library" icon="book-open" size="sm" onPress={() => {
                void updateSocialInboxItem(uid, item.id, { read: true });
                router.push('/knowledge');
              }} />
            ) : item.type === 'sprint' ? (
              <Button label="Open sprint" icon="users-round" size="sm" onPress={() => {
                void updateSocialInboxItem(uid, item.id, { read: true });
                router.push('/social?tab=sprints');
              }} />
            ) : !item.readAt ? (
              <Button label="Mark read" icon="check" variant="secondary" size="sm" onPress={() => void updateSocialInboxItem(uid, item.id, { read: true })} />
            ) : null}
          </View>
        </Card>
      ))}
    </View>
  );
}

function inboxIcon(type: SocialInboxItem['type']): IconName {
  if (type === 'availability') return 'clock';
  if (type === 'share') return 'share-2';
  if (type === 'sprint') return 'users-round';
  return 'book-open';
}

function CourseCircles({ me, profile }: { me: ConversationMember; profile: Profile | null }) {
  const uid = useUid();
  const subjects = useCollection<Subject>(paths.subjects(getDb(), uid), [uid]);
  const [circleId, setCircleId] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(subject: Subject) {
    setJoining(subject.id);
    setError(null);
    try {
      const id = await openOrJoinCircle({
        member: me,
        courseCode: subject.moduleCode || '',
        courseName: subject.name,
        universityId: profile?.universityId || '',
        universityName: profile?.university || '',
      });
      setCircleId(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJoining(null);
    }
  }

  if (circleId) return <CircleThread circleId={circleId} me={me} onBack={() => setCircleId(null)} />;
  if (profile?.shareCourses !== true) {
    return <Notice tone="amber" title="Course circles are off" body="Enable classmate discovery in Privacy and people before joining a course circle." />;
  }

  return (
    <View className="gap-3">
      {error ? <Notice title="Could not open that course circle" body={error} /> : null}
      <Text className="text-sm leading-6 text-muted">Circles contain students from your university who opted into the same course code. Each circle is capped at 20 members.</Text>
      {subjects.data.filter((subject) => subject.moduleCode).map((subject) => (
        <Card key={subject.id} className="flex-row items-center gap-3 p-4">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-sand"><Icon name="book-open" size={17} tone="accent" /></View>
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{subject.name}</Text>
            <Text className="text-xs text-muted">{subject.moduleCode}</Text>
          </View>
          <Button label="Open" icon="arrow-right" size="sm" loading={joining === subject.id} onPress={() => void open(subject)} />
        </Card>
      ))}
    </View>
  );
}

function CircleThread({ circleId, me, onBack }: { circleId: string; me: ConversationMember; onBack: () => void }) {
  const circle = useDocument<StudyCircle>(paths.circle(getDb(), circleId), [circleId]);
  const posts = useCollection<CirclePost>(
    query(paths.circlePosts(getDb(), circleId), orderBy('createdAt', 'desc'), limit(50)),
    [circleId]
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sendCirclePost({ circleId, senderId: me.id, senderName: me.displayName, text });
      setText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-3 p-4">
      <Touchable onPress={onBack} className="self-start flex-row items-center gap-2 py-1">
        <Icon name="arrow-left" size={15} tone="muted" />
        <Text className="text-xs font-semibold text-muted">Course circles</Text>
      </Touchable>
      <View>
        <Text className="font-heading text-xl font-semibold text-ink">{circle.data?.courseCode || 'Course circle'}</Text>
        <Text className="text-xs text-muted">{circle.data?.memberIds.length ?? 0} members · {circle.data?.universityName || ''}</Text>
      </View>
      {error ? <Notice title="Could not post" body={error} /> : null}
      <ScrollView className="max-h-[420px]" contentContainerClassName="gap-2 py-2">
        {[...posts.data].reverse().map((post) => (
          <View key={post.id} className={`max-w-[88%] rounded-2xl px-3 py-2 ${post.senderId === me.id ? 'self-end bg-ink' : 'self-start bg-sand'}`}>
            {post.senderId !== me.id ? <Text className="mb-1 text-[11px] font-semibold text-accent">{post.senderName}</Text> : null}
            <Text className={`text-sm leading-5 ${post.senderId === me.id ? 'text-paper' : 'text-ink'}`}>{post.text}</Text>
          </View>
        ))}
      </ScrollView>
      <View className="flex-row items-end gap-2 border-t border-line pt-3">
        <View className="min-w-0 flex-1">
          <Field value={text} onChangeText={setText} placeholder="Post to the circle" multiline maxLength={1500} className="max-h-28" />
        </View>
        <Button label="Post" icon="send" size="sm" loading={busy} disabled={!text.trim()} onPress={() => void send()} />
      </View>
    </Card>
  );
}
