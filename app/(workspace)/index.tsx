import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { CardGrid, GridItem, SubjectCard } from '@/components/SubjectCard';
import { ScreenScroll } from '@/components/ScreenScroll';
import { UploadButton } from '@/components/UploadButton';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useAuth, useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { bucketFor, formatDue, toDate } from '@/lib/dates';
import { getDb } from '@/lib/firebase';
import { paths } from '@/lib/paths';
import type { Subject, Todo } from '@/lib/schema';

export default function Dashboard() {
  const uid = useUid();
  const { user } = useAuth();
  const db = getDb();

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );

  /**
   * Ordered on a single field so Firestore serves this from the automatic
   * single-field index. Adding `where('isCompleted','==',false)` would demand a
   * composite index for no real benefit — a student's task list is small, and
   * the open/overdue split below is a cheap client-side pass.
   */
  const todos = useCollection<Todo>(query(paths.todos(db, uid), orderBy('dueDate', 'asc')), [uid]);

  const open = useMemo(() => todos.data.filter((todo) => !todo.isCompleted), [todos.data]);

  const upcoming = useMemo(
    () =>
      open
        .map((todo) => ({ todo, due: toDate(todo.dueDate) }))
        .filter(({ due }) => due !== null)
        .slice(0, 5),
    [open]
  );

  const overdueCount = useMemo(
    () => open.filter((todo) => bucketFor(toDate(todo.dueDate)) === 'overdue').length,
    [open]
  );

  const sourceCount = useMemo(
    () => subjects.data.reduce((total, subject) => total + (subject.documentCount ?? 0), 0),
    [subjects.data]
  );

  const firstName = (user?.displayName || '').split(' ')[0];

  return (
    <ScreenScroll>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        subtitle="Upload a syllabus or lecture and Notomi will file it, summarise it, and pull out your deadlines."
        actions={<UploadButton />}
      />

      {subjects.error ? (
        <View className="mb-6">
          <Notice
            title="Could not load your library"
            body={`${subjects.error.message} — if this mentions permissions, deploy firestore.rules.`}
          />
        </View>
      ) : null}

      <View className="mb-8 flex-row flex-wrap gap-3">
        <Stat icon="folder" value={subjects.data.length} label="Subjects" />
        <Stat icon="file-text" value={sourceCount} label="Sources" />
        <Stat icon="check-square" value={open.length} label="Open tasks" />
        <Stat
          icon="alert-circle"
          value={overdueCount}
          label="Overdue"
          tone={overdueCount > 0 ? 'rose' : 'neutral'}
        />
      </View>

      <View className="mb-6 flex-row items-center justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink">Your subjects</Text>
        {subjects.data.length > 0 ? (
          <Link href="/library" asChild>
            <Button label="View library" variant="ghost" size="sm" />
          </Link>
        ) : null}
      </View>

      {subjects.loading ? (
        <Loading label="Loading your subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="upload-cloud"
          title="No subjects yet"
          body="Upload a PDF or DOCX. Notomi reads it on your device, then Gemini names the subject, summarises it and extracts every deadline it can find."
          action={<UploadButton label="Upload your first document" />}
        />
      ) : (
        <CardGrid>
          {subjects.data.map((subject) => (
            <GridItem key={subject.id}>
              <SubjectCard subject={subject} />
            </GridItem>
          ))}
        </CardGrid>
      )}

      <View className="mt-10 mb-6 flex-row items-center justify-between">
        <Text className="text-lg font-semibold tracking-tight text-ink">Coming up</Text>
        <Link href="/todos" asChild>
          <Button label="All to-dos" variant="ghost" size="sm" />
        </Link>
      </View>

      {upcoming.length === 0 ? (
        <Card className="items-start">
          <Text className="text-sm text-muted">
            Nothing scheduled. Deadlines found in an uploaded syllabus land here automatically.
          </Text>
        </Card>
      ) : (
        <Card className="gap-0 p-0">
          {upcoming.map(({ todo, due }, index) => {
            const bucket = bucketFor(due);
            return (
              <View
                key={todo.id}
                className={`flex-row items-center gap-3 px-5 py-3.5 ${
                  index > 0 ? 'border-t border-line' : ''
                }`}
              >
                <View
                  className={`h-2 w-2 rounded-full ${
                    bucket === 'overdue' ? 'bg-rose' : bucket === 'today' ? 'bg-accent' : 'bg-subtle'
                  }`}
                />
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px] font-medium text-ink" numberOfLines={1}>
                    {todo.title}
                  </Text>
                  {todo.subjectName ? (
                    <Text className="text-xs text-subtle" numberOfLines={1}>
                      {todo.subjectName}
                    </Text>
                  ) : null}
                </View>
                <Text
                  className={`text-[13px] font-medium ${
                    bucket === 'overdue' ? 'text-rose' : 'text-muted'
                  }`}
                >
                  {formatDue(due)}
                </Text>
              </View>
            );
          })}
        </Card>
      )}
    </ScreenScroll>
  );
}

function Stat({
  icon,
  value,
  label,
  tone = 'neutral',
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: number;
  label: string;
  tone?: 'neutral' | 'rose';
}) {
  return (
    <View
      className="flex-1 grow gap-2 rounded-2xl border border-line bg-surface p-4"
      style={{ minWidth: 140, flexBasis: 140 }}
    >
      <Feather name={icon} size={15} color={tone === 'rose' ? '#B0443E' : '#9A9488'} />
      <Text className={`text-2xl font-bold ${tone === 'rose' ? 'text-rose' : 'text-ink'}`}>
        {value}
      </Text>
      <Text className="text-[13px] text-muted">{label}</Text>
    </View>
  );
}
