import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { orderBy, query, where } from 'firebase/firestore';
import { Icon } from '@/components/Icon';
import { FileDropZone } from '@/components/FileDropZone';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import { Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { extractText } from '@/services/fileProcessor';
import { pickMaterials, type MaterialFile } from '@/services/ingestion';
import { friendsPath, type Friend } from '@/services/social';
import {
  attachSprintDraft,
  createGroupSprint,
  toggleSprintTask,
  type GroupSprint,
  type SprintTask,
} from '@/services/sprints';

export function GroupSprints() {
  const uid = useUid();
  const db = getDb();
  const sprints = useCollection<GroupSprint>(
    query(paths.sprints(db), where('memberIds', 'array-contains', uid)),
    [uid]
  );
  const [creating, setCreating] = useState(false);

  return (
    <ScreenScroll>
      <PageHeader
        title="Group Sprints"
        subtitle="Shared course projects with fair, availability-aware delegation."
        actions={<Button label="New sprint" icon="plus" size="sm" onPress={() => setCreating(true)} />}
      />
      {sprints.loading ? (
        <Loading label="Loading project rooms…" />
      ) : sprints.error ? (
        <Notice title="Could not load group sprints" body={sprints.error.message} />
      ) : sprints.data.length === 0 ? (
        <EmptyState
          icon="users-round"
          title="No group sprints yet"
          body="Create one from an assignment brief. Notomi divides the work and balances it against each member’s free-time gaps."
          action={<Button label="Create a sprint" icon="plus" onPress={() => setCreating(true)} />}
        />
      ) : (
        <View className="gap-5">
          {sprints.data.map((sprint) => <SprintCard key={sprint.id} sprint={sprint} uid={uid} />)}
        </View>
      )}
      <CreateSprint visible={creating} onClose={() => setCreating(false)} />
    </ScreenScroll>
  );
}

function CreateSprint({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();
  const subjects = useCollection<Subject>(query(paths.subjects(db, uid), orderBy('name')), [uid]);
  const friends = useCollection<Friend>(friendsPath(db, uid), [uid]);
  const accepted = friends.data.filter((friend) => friend.status === 'accepted');
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [guidelines, setGuidelines] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingBrief, setReadingBrief] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subject = subjects.data.find((entry) => entry.id === subjectId) ?? null;
  const myName = user?.displayName || user?.email?.split('@')[0] || 'You';

  async function readBrief(files: MaterialFile[]) {
    setReadingBrief(true);
    setError(null);
    try {
      const sections: string[] = [];
      for (const file of files) {
        const bytes = file.file
          ? await file.file.arrayBuffer()
          : await (await fetch(file.uri)).arrayBuffer();
        const result = await extractText(bytes, file.name, file.mimeType ?? '');
        if (result.text.trim()) sections.push(`# ${file.name}\n\n${result.text.trim()}`);
      }
      if (!sections.length) throw new Error('No readable assignment guidelines were found.');
      setGuidelines(sections.join('\n\n'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReadingBrief(false);
    }
  }

  async function create() {
    if (!subject) return;
    setBusy(true);
    setError(null);
    try {
      await createGroupSprint({
        uid,
        title,
        subjectId: subject.id,
        subjectName: subject.name,
        guidelines,
        members: [
          { id: uid, name: myName },
          ...accepted
            .filter((friend) => memberIds.includes(friend.id))
            .map((friend) => ({ id: friend.id, name: friend.displayName })),
        ],
      });
      setTitle('');
      setSubjectId('');
      setMemberIds([]);
      setGuidelines('');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="New group sprint"
      icon="users-round"
      dismissOnScrim={false}
      maxHeight={720}
      footer={
        <>
          <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} disabled={busy} />
          <View className="flex-1" />
          <Button
            label="Delegate project"
            icon="network"
            size="sm"
            loading={busy}
            disabled={
              readingBrief || !subject || memberIds.length === 0 || guidelines.trim().length < 80
            }
            onPress={() => void create()}
          />
        </>
      }
    >
      {error ? <Notice title="Could not create the sprint" body={error} /> : null}
      <Field label="Project name" value={title} onChangeText={setTitle} placeholder="Research presentation" />
      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Course</Text>
        <View className="flex-row flex-wrap gap-2">
          {subjects.data.map((entry) => (
            <Choice
              key={entry.id}
              label={entry.moduleCode || entry.name}
              selected={entry.id === subjectId}
              onPress={() => setSubjectId(entry.id)}
            />
          ))}
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Team members</Text>
        {accepted.length === 0 ? (
          <Text className="text-xs leading-5 text-subtle">Add friends before creating a shared project.</Text>
        ) : (
          <View className="flex-row flex-wrap gap-2">
            {accepted.map((friend) => (
              <Choice
                key={friend.id}
                label={friend.displayName}
                selected={memberIds.includes(friend.id)}
                onPress={() =>
                  setMemberIds((current) =>
                    current.includes(friend.id)
                      ? current.filter((id) => id !== friend.id)
                      : [...current, friend.id]
                  )
                }
              />
            ))}
          </View>
        )}
      </View>
      <FileDropZone
        busy={readingBrief}
        title="Add assignment guidelines"
        body="Drop a PDF, image or slide deck, or paste the guidelines below."
        onFiles={readBrief}
      />
      <Field
        label="Assignment guidelines"
        value={guidelines}
        onChangeText={setGuidelines}
        placeholder="Paste the group assignment brief, deliverables, rubric, and due date…"
        multiline
        className="min-h-40"
        textAlignVertical="top"
      />
      <Text className="text-xs leading-5 text-subtle">
        Delegation uses only each member’s available-hour totals. Private class names and rooms are never shared.
      </Text>
    </Sheet>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      className={`rounded-xl px-3 py-2 ${selected ? 'bg-ink' : 'bg-sand'}`}
    >
      <Text className={`text-xs font-semibold ${selected ? 'text-paper' : 'text-muted'}`}>{label}</Text>
    </Pressable>
  );
}

function SprintCard({ sprint, uid }: { sprint: GroupSprint; uid: string }) {
  const [open, setOpen] = useState(true);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const complete = sprint.tasks.filter((task) => task.completed).length;
  const progress = sprint.tasks.length ? complete / sprint.tasks.length : 0;
  const memberProgress = useMemo(
    () =>
      sprint.members.map((member) => {
        const tasks = sprint.tasks.filter((task) => task.assigneeId === member.id);
        return {
          ...member,
          total: tasks.length,
          done: tasks.filter((task) => task.completed).length,
        };
      }),
    [sprint.members, sprint.tasks]
  );

  async function attach(task: SprintTask) {
    setBusyTask(task.id);
    setError(null);
    try {
      const files = await pickMaterials();
      if (files[0]) await attachSprintDraft({ uid, sprint, taskId: task.id, file: files[0] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTask(null);
    }
  }

  return (
    <Card className="gap-4">
      <Pressable onPress={() => setOpen((value) => !value)} className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-accent-soft">
          <Icon name="users-round" size={18} color="#B4552D" />
        </View>
        <View className="flex-1 gap-1">
          <Text className="font-heading text-lg text-ink">{sprint.title}</Text>
          <Text className="text-xs text-muted">{sprint.subjectName} · {complete}/{sprint.tasks.length} milestones</Text>
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={17} color="#6F6A5F" />
      </Pressable>
      <View className="h-2 overflow-hidden rounded-full bg-sand">
        <View className="h-full rounded-full bg-pine" style={{ width: `${progress * 100}%` }} />
      </View>
      {open ? (
        <View className="gap-5">
          <View className="gap-2">
            {memberProgress.map((member) => (
              <View key={member.id} className="gap-1">
                <View className="flex-row justify-between gap-2">
                  <Text className="text-xs font-semibold text-ink">{member.name}</Text>
                  <Text className="text-xs text-muted">{member.done}/{member.total}</Text>
                </View>
                <View className="h-1.5 overflow-hidden rounded-full bg-sand">
                  <View
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${member.total ? (member.done / member.total) * 100 : 0}%` }}
                  />
                </View>
              </View>
            ))}
          </View>
          {error ? <Notice title="Could not attach that draft" body={error} /> : null}
          <View className="gap-2">
            {sprint.tasks.map((task) => (
              <View key={task.id} className="rounded-xl border border-line bg-surface p-3.5">
                <View className="flex-row items-start gap-3">
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: task.completed }}
                    onPress={() => void toggleSprintTask(sprint.id, task.id)}
                    className={`mt-0.5 h-5 w-5 items-center justify-center rounded-md border ${
                      task.completed ? 'border-pine bg-pine' : 'border-line bg-surface'
                    }`}
                  >
                    {task.completed ? <Icon name="check" size={12} color="#FFFFFF" /> : null}
                  </Pressable>
                  <View className="flex-1 gap-1">
                    <Text className={`text-sm font-semibold ${task.completed ? 'text-subtle line-through' : 'text-ink'}`}>
                      {task.title}
                    </Text>
                    <Text className="text-xs leading-5 text-muted">{task.detail}</Text>
                    <Text className="text-[11px] font-semibold text-accent">
                      {task.assigneeName} · {task.estimatedHours} hours
                    </Text>
                    {(task.attachments ?? []).map((attachment) => (
                      <View key={`${attachment.fileKey}-${attachment.attachedAtMillis}`} className="flex-row items-center gap-1.5">
                        <Icon name="file-text" size={12} color="#6F6A5F" />
                        <Text className="flex-1 text-[11px] text-muted" numberOfLines={1}>{attachment.fileName}</Text>
                      </View>
                    ))}
                  </View>
                  <Button
                    label="Attach"
                    icon="paperclip"
                    size="sm"
                    variant="ghost"
                    loading={busyTask === task.id}
                    onPress={() => void attach(task)}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}
