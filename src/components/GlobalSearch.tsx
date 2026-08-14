import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { getDocs, orderBy, query } from 'firebase/firestore';
import { useUid } from '@/hooks/useAuth';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject, Todo } from '@/lib/schema';
import { getDb } from '@/services/firebase';

/**
 * Command palette over everything the student has: subject names, document
 * text, generated notes and to-do titles.
 *
 * Firestore cannot do substring or full-text matching, so the index is built
 * on the client. It is loaded once when the palette first opens and kept for
 * the session — a student's corpus is tens of documents, not millions, and a
 * per-keystroke round trip would be both slower and needlessly billed.
 */

type Hit = {
  id: string;
  kind: 'subject' | 'document' | 'notes' | 'todo';
  title: string;
  subtitle: string;
  /** The matched line, with the query in context. */
  snippet: string | null;
  href: string;
};

type Entry = {
  kind: Hit['kind'];
  title: string;
  subtitle: string;
  href: string;
  haystack: string;
  body: string;
};

const KIND_META: Record<Hit['kind'], { icon: 'folder' | 'file-text' | 'feather' | 'check-square'; label: string }> = {
  subject: { icon: 'folder', label: 'Subject' },
  document: { icon: 'file-text', label: 'Document' },
  notes: { icon: 'feather', label: 'Notes' },
  todo: { icon: 'check-square', label: 'To-do' },
};

export function GlobalSearch() {
  const uid = useUid();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<TextInput>(null);

  /* --------------------------- Keyboard --------------------------- */

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = getDb();
      const [subjectSnapshot, todoSnapshot] = await Promise.all([
        getDocs(query(paths.subjects(db, uid), orderBy('updatedAt', 'desc'))),
        getDocs(paths.todos(db, uid)),
      ]);

      const built: Entry[] = [];

      for (const subjectDoc of subjectSnapshot.docs) {
        const subject = { id: subjectDoc.id, ...subjectDoc.data() } as Subject;
        built.push({
          kind: 'subject',
          title: subject.name,
          subtitle: subject.moduleCode ?? `${subject.documentCount ?? 0} sources`,
          href: `/knowledge/subject/${subject.id}`,
          haystack: `${subject.name} ${subject.moduleCode ?? ''}`.toLowerCase(),
          body: '',
        });
      }

      // Documents are fetched per subject; there is no collection-group query
      // that stays inside the per-user security rules.
      const documentSnapshots = await Promise.all(
        subjectSnapshot.docs.map((subjectDoc) =>
          getDocs(paths.documents(getDb(), uid, subjectDoc.id)).then(
            (snapshot) => [subjectDoc, snapshot] as const
          )
        )
      );

      for (const [subjectDoc, snapshot] of documentSnapshots) {
        const subjectName = (subjectDoc.data().name as string) ?? 'Subject';
        for (const documentDoc of snapshot.docs) {
          const record = { id: documentDoc.id, ...documentDoc.data() } as SourceDocument;
          const href = `/knowledge/subject/${subjectDoc.id}/${record.id}`;
          const text = record.rawText ?? '';

          built.push({
            kind: 'document',
            title: record.title || record.fileName,
            subtitle: subjectName,
            href,
            haystack: `${record.title} ${record.fileName} ${record.summary ?? ''} ${text}`.toLowerCase(),
            body: text,
          });

          if (record.notes) {
            built.push({
              kind: 'notes',
              title: `Notes · ${record.title || record.fileName}`,
              subtitle: subjectName,
              href,
              haystack: record.notes.toLowerCase(),
              body: record.notes,
            });
          }
        }
      }

      for (const todoDoc of todoSnapshot.docs) {
        const todo = { id: todoDoc.id, ...todoDoc.data() } as Todo;
        built.push({
          kind: 'todo',
          title: todo.title,
          subtitle: todo.subjectName ?? (todo.isCompleted ? 'Completed' : 'To-do'),
          href: '/tasks',
          haystack: todo.title.toLowerCase(),
          body: '',
        });
      }

      setEntries(built);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    if (entries === null && !loading) void load();
    // Autofocus has to wait for the modal to mount its content.
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [open, entries, loading, load]);

  const hits = useMemo<Hit[]>(() => {
    const needle = term.trim().toLowerCase();
    if (!needle || !entries) return [];

    const results: Hit[] = [];
    for (let index = 0; index < entries.length && results.length < 40; index += 1) {
      const entry = entries[index];
      const at = entry.haystack.indexOf(needle);
      if (at < 0) continue;

      results.push({
        id: `${entry.kind}-${index}`,
        kind: entry.kind,
        title: entry.title,
        subtitle: entry.subtitle,
        snippet: entry.body ? snippetAround(entry.body, needle) : null,
        href: entry.href,
      });
    }

    // Titles before body matches: a subject called "Statistics" should beat the
    // hundredth line of a lecture that happens to mention it.
    return results.sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(needle) ? 0 : 1;
      const bTitle = b.title.toLowerCase().includes(needle) ? 0 : 1;
      return aTitle - bTitle;
    });
  }, [term, entries]);

  const go = useCallback(
    (hit: Hit) => {
      setOpen(false);
      setTerm('');
      router.push(hit.href as never);
    },
    [router]
  );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search everything"
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
      >
        <Icon name="search" size={14} color="#9A9488" />
        <Text className="flex-1 text-xs text-subtle">Search everything</Text>
        {/* Only advertise the shortcut where a keyboard is likely. */}
        {Platform.OS === 'web' && width >= 900 ? (
          <View className="rounded bg-sand px-1.5 py-0.5">
            <Text className="text-[10px] font-semibold text-muted">⌘K</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Scrim behind, panel beside it — never nested. A Pressable is a
            <button> on web and activates on Space, so a space typed into the
            search field used to close the palette. */}
        <View className="flex-1 items-center px-5 pt-16">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close search"
            onPress={() => setOpen(false)}
            focusable={false}
            style={StyleSheet.absoluteFill}
            className="bg-ink/40"
          />

          <View className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface">
            <View className="flex-row items-center gap-3 border-b border-line px-4 py-3">
              <Icon name="search" size={16} color="#6F6A5F" />
              <TextInput
                ref={inputRef}
                value={term}
                onChangeText={setTerm}
                placeholder="Search subjects, documents, notes and to-dos"
                placeholderTextColor="#9A9488"
                autoCorrect={false}
                autoCapitalize="none"
                onSubmitEditing={() => hits[selected] && go(hits[selected])}
                className="flex-1 text-[15px] text-ink"
              />
              {loading ? <ActivityIndicator size="small" color="#B4552D" /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setOpen(false)}
                className="h-7 w-7 items-center justify-center rounded-lg"
              >
                <Icon name="x" size={14} color="#6F6A5F" />
              </Pressable>
            </View>

            <ScrollView className="max-h-[420px]" contentContainerClassName="p-2">
              {error ? (
                <Text className="px-3 py-6 text-center text-sm text-rose">{error}</Text>
              ) : !term.trim() ? (
                <Text className="px-3 py-8 text-center text-sm text-muted">
                  {loading
                    ? 'Indexing your library…'
                    : `Type to search ${entries?.length ?? 0} items across your workspace.`}
                </Text>
              ) : hits.length === 0 ? (
                <Text className="px-3 py-8 text-center text-sm text-muted">
                  Nothing matches “{term.trim()}”.
                </Text>
              ) : (
                hits.map((hit, index) => (
                  <Pressable
                    key={hit.id}
                    accessibilityRole="button"
                    onPress={() => go(hit)}
                    onHoverIn={() => setSelected(index)}
                    className={`flex-row items-start gap-3 rounded-xl px-3 py-2.5 ${
                      index === selected ? 'bg-sand' : ''
                    }`}
                  >
                    <View className="mt-0.5 h-7 w-7 items-center justify-center rounded-lg bg-sand">
                      <Icon name={KIND_META[hit.kind].icon} size={13} color="#6F6A5F" />
                    </View>

                    <View className="flex-1 gap-0.5">
                      <Text className="text-sm font-medium text-ink" numberOfLines={1}>
                        {hit.title}
                      </Text>
                      <Text className="text-xs text-subtle" numberOfLines={1}>
                        {KIND_META[hit.kind].label} · {hit.subtitle}
                      </Text>
                      {hit.snippet ? (
                        <Text className="mt-0.5 text-xs leading-5 text-muted" numberOfLines={2}>
                          {hit.snippet}
                        </Text>
                      ) : null}
                    </View>

                    <Icon name="corner-down-left" size={13} color="#9A9488" />
                  </Pressable>
                ))
              )}
            </ScrollView>

            {entries !== null && !loading ? (
              <View className="flex-row items-center justify-between border-t border-line px-4 py-2">
                <Text className="text-[11px] text-subtle">
                  {hits.length > 0 ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : ''}
                </Text>
                <Pressable accessibilityRole="button" onPress={() => void load()}>
                  <Text className="text-[11px] font-medium text-muted">Refresh index</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

/** A window of text around the first match, so a hit shows its context. */
function snippetAround(body: string, needle: string): string | null {
  const at = body.toLowerCase().indexOf(needle);
  if (at < 0) return null;

  const start = Math.max(0, at - 60);
  const end = Math.min(body.length, at + needle.length + 120);
  const slice = body
    .slice(start, end)
    // Notes are Markdown; a preview full of pipes and hashes reads as noise.
    .replace(/[#*`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${start > 0 ? '…' : ''}${slice}${end < body.length ? '…' : ''}`;
}
