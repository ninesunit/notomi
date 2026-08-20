import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { NoteNotebook, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  deleteNoteNotebook,
  listNoteNotebooks,
  NOTE_LIMITS,
  saveNoteNotebook,
} from '@/services/notes';

const NOTEBOOK_COLORS = ['#B4552D', '#2E6F5E', '#4C5FA8', '#8A4B86', '#4A5568'];

function newId(prefix: string): string {
  const token = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${token}`;
}

export function NotebookShelf() {
  const userId = useUid();
  const router = useRouter();
  const params = useLocalSearchParams<{ subjectId?: string }>();
  const handledSubjectLink = useRef(false);
  const subjects = useCollection<Subject>(paths.subjects(getDb(), userId), [userId]);
  const [notebooks, setNotebooks] = useState<NoteNotebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [color, setColor] = useState(NOTEBOOK_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotebooks(await listNoteNotebooks(userId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (handledSubjectLink.current || !params.subjectId || !subjects.data.some((subject) => subject.id === params.subjectId)) return;
    handledSubjectLink.current = true;
    setSubjectId(params.subjectId);
    setCreateOpen(true);
  }, [params.subjectId, subjects.data]);

  const subjectMap = useMemo(
    () => new Map(subjects.data.map((subject) => [subject.id, subject])),
    [subjects.data]
  );

  const createNotebook = useCallback(async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Give the notebook a name.');
      return;
    }
    if (notebooks.length >= NOTE_LIMITS.notebooks) {
      setError(`You can keep up to ${NOTE_LIMITS.notebooks} notebooks per account.`);
      return;
    }

    const subject = subjectId ? subjectMap.get(subjectId) ?? null : null;
    const now = Date.now();
    const notebookId = newId('notebook');
    const notebook: NoteNotebook = {
      id: notebookId,
      title: cleanTitle,
      subjectId: subject?.id ?? null,
      subjectCode: subject?.moduleCode ?? null,
      subjectName: subject?.name ?? null,
      color,
      pages: [
        {
          id: newId('page'),
          title: 'Page 1',
          order: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    setSaving(true);
    setError(null);
    try {
      await saveNoteNotebook(userId, notebook);
    } catch (saveError) {
      setError(`Notebook saved on this device. Cloud backup will retry when the connection is available. ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    } finally {
      setSaving(false);
    }
    setNotebooks((current) => [notebook, ...current]);
    setCreateOpen(false);
    setTitle('');
    setSubjectId(null);
    router.push(`/knowledge/notes/${notebook.id}?page=${notebook.pages[0].id}` as never);
  }, [color, notebooks.length, router, subjectId, subjectMap, title, userId]);

  const removeNotebook = useCallback(
    async (notebook: NoteNotebook) => {
      if (typeof window !== 'undefined' && !window.confirm(`Delete “${notebook.title}” and all of its pages?`)) {
        return;
      }
      setNotebooks((current) => current.filter((entry) => entry.id !== notebook.id));
      try {
        await deleteNoteNotebook(userId, notebook);
      } catch (deleteError) {
        setNotebooks((current) => [notebook, ...current]);
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    },
    [userId]
  );

  return (
    <ScrollView className="flex-1 bg-paper" contentContainerClassName="mx-auto w-full max-w-6xl gap-5 px-5 py-6 md:px-8">
      <PageHeader
        title="Notomi Notes"
        subtitle="Subject notebooks and personal workspaces, available offline on this device."
        actions={<Button label="New notebook" icon="file-plus" onPress={() => setCreateOpen(true)} />}
      />

      {error ? <Notice title="Notes needs attention" body={error} /> : null}

      <View className="flex-row flex-wrap gap-3 rounded-2xl border border-line bg-surface p-4">
        <ShelfStat icon="notebook-pen" label="Notebooks" value={String(notebooks.length)} />
        <ShelfStat
          icon="file-text"
          label="Pages"
          value={String(notebooks.reduce((total, notebook) => total + notebook.pages.length, 0))}
        />
        <ShelfStat icon="shield" label="Local first" value="3 sec backup" />
      </View>

      {loading ? (
        <Loading label="Opening your notebook shelf" />
      ) : notebooks.length === 0 ? (
        <EmptyState
          icon="notebook-pen"
          title="No notebooks yet"
          body="Create a notebook for a course, or leave it unassigned for ideas, planning and personal notes."
          action={<Button label="Create your first notebook" icon="file-plus" onPress={() => setCreateOpen(true)} />}
        />
      ) : (
        <View className="flex-row flex-wrap gap-4">
          {notebooks.map((notebook) => (
            <Pressable
              key={notebook.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${notebook.title}`}
              onPress={() => router.push(`/knowledge/notes/${notebook.id}?page=${notebook.pages[0]?.id ?? ''}` as never)}
              className="min-w-[260px] flex-1 overflow-hidden rounded-2xl border border-line bg-surface"
              style={{ maxWidth: 520 }}
            >
              <View style={{ height: 6, backgroundColor: notebook.color }} />
              <View className="gap-4 p-5">
                <View className="flex-row items-start gap-3">
                  <View className="h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: `${notebook.color}18` }}>
                    <Icon name="notebook-pen" size={20} color={notebook.color} />
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="font-heading text-base font-semibold text-ink" numberOfLines={1}>{notebook.title}</Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {notebook.subjectCode || notebook.subjectName || 'Personal notebook'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${notebook.title}`}
                    hitSlop={8}
                    onPress={(event) => {
                      event.stopPropagation();
                      void removeNotebook(notebook);
                    }}
                    className="h-9 w-9 items-center justify-center rounded-lg"
                  >
                    <Icon name="trash-2" size={16} tone="subtle" />
                  </Pressable>
                </View>
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-medium text-muted">
                    {notebook.pages.length} {notebook.pages.length === 1 ? 'page' : 'pages'}
                  </Text>
                  <View className="flex-row items-center gap-1">
                    <Text className="text-xs font-semibold text-ink">Open</Text>
                    <Icon name="arrow-right" size={14} tone="ink" />
                  </View>
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      <Text className="pb-4 text-xs leading-5 text-subtle">
        Safety limits: {NOTE_LIMITS.notebooks} notebooks, {NOTE_LIMITS.pagesPerNotebook} pages per notebook and {NOTE_LIMITS.nodesPerPage.toLocaleString()} objects per page. These prevent an individual iPad tab from exhausting memory.
      </Text>

      <Sheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create notebook"
        icon="notebook-pen"
        footer={
          <View className="w-full flex-row justify-end gap-2">
            <Button label="Cancel" variant="ghost" onPress={() => setCreateOpen(false)} />
            <Button label="Create" icon="file-plus" loading={saving} onPress={() => void createNotebook()} />
          </View>
        }
      >
        <Field label="Notebook name" value={title} onChangeText={setTitle} placeholder="Research Methods notes" autoFocus />
        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Course or subject</Text>
          <View className="flex-row flex-wrap gap-2">
            <Choice active={subjectId === null} label="Personal / extra" onPress={() => setSubjectId(null)} />
            {subjects.data.map((subject) => (
              <Choice
                key={subject.id}
                active={subjectId === subject.id}
                label={subject.moduleCode || subject.name}
                onPress={() => {
                  setSubjectId(subject.id);
                  if (!title.trim()) setTitle(`${subject.moduleCode || subject.name} Notes`);
                }}
              />
            ))}
          </View>
        </View>
        <View className="gap-2">
          <Text className="text-sm font-medium text-muted">Cover colour</Text>
          <View className="flex-row gap-3">
            {NOTEBOOK_COLORS.map((entry) => (
              <Pressable
                key={entry}
                accessibilityRole="button"
                accessibilityLabel={`Use ${entry} cover colour`}
                accessibilityState={{ selected: color === entry }}
                onPress={() => setColor(entry)}
                className={`h-9 w-9 items-center justify-center rounded-full ${color === entry ? 'border-2 border-ink' : ''}`}
              >
                <View className="h-6 w-6 rounded-full" style={{ backgroundColor: entry }} />
              </Pressable>
            ))}
          </View>
        </View>
      </Sheet>
    </ScrollView>
  );
}

function Choice({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className={`rounded-full border px-3 py-2 ${active ? 'border-ink bg-ink' : 'border-line bg-surface'}`}>
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}

function ShelfStat({ icon, label, value }: { icon: 'notebook-pen' | 'file-text' | 'shield'; label: string; value: string }) {
  return (
    <View className="min-w-[150px] flex-1 flex-row items-center gap-3">
      <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
        <Icon name={icon} size={16} tone="muted" />
      </View>
      <View>
        <Text className="text-xs text-muted">{label}</Text>
        <Text className="text-sm font-semibold text-ink">{value}</Text>
      </View>
    </View>
  );
}
