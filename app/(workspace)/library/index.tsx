import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { useRouter } from 'expo-router';
import { CardGrid, GridItem, SubjectCard } from '@/components/SubjectCard';
import { SubjectModal } from '@/components/SubjectModal';
import {
  defaultScope,
  filterByTerm,
  TermFilter,
  type TermScope,
} from '@/components/TermFilter';
import { UploadButton } from '@/components/UploadButton';
import { Button, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { Semester, Subject } from '@/lib/schema';

/** Root of the library: one folder per subject, live from Firestore. */
export default function Library() {
  const uid = useUid();
  const router = useRouter();
  const [search, setSearch] = useState('');
  /** 'new' opens the create flow; a Subject opens the editor for that folder. */
  const [editing, setEditing] = useState<Subject | 'new' | null>(null);

  const db = getDb();
  const { data, loading, error } = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );
  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );

  /**
   * Null until the data lands, then the current term. Choosing eagerly would
   * pin the scope to 'all' before we know which term is live.
   */
  const [scope, setScope] = useState<TermScope | null>(null);
  const activeScope = scope ?? defaultScope(data, semesters.data);

  const inTerm = useMemo(
    () => filterByTerm(data, activeScope, semesters.data),
    [data, activeScope, semesters.data]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return inTerm;
    return inTerm.filter((subject) =>
      `${subject.name} ${subject.moduleCode ?? ''}`.toLowerCase().includes(needle)
    );
  }, [inTerm, search]);

  const totalSources = useMemo(
    () => inTerm.reduce((total, subject) => total + (subject.documentCount ?? 0), 0),
    [inTerm]
  );

  const scopeName =
    activeScope === 'all'
      ? null
      : activeScope === 'unassigned'
        ? 'Unfiled'
        : (semesters.data.find((semester) => semester.id === activeScope)?.name ?? null);

  return (
    <ScreenScroll>
      <PageHeader
        title="Library"
        subtitle={
          data.length
            ? [
                scopeName,
                `${inTerm.length} ${inTerm.length === 1 ? 'subject' : 'subjects'}`,
                `${totalSources} ${totalSources === 1 ? 'source' : 'sources'}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'Every document you upload is filed into a subject folder.'
        }
        actions={
          <>
            <Button
              label="New subject"
              icon="folder-plus"
              variant="secondary"
              size="sm"
              onPress={() => setEditing('new')}
            />
            <UploadButton />
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not load your library" body={error.message} />
        </View>
      ) : null}

      {data.length > 0 ? (
        <TermFilter
          semesters={semesters.data}
          subjects={data}
          scope={activeScope}
          onScope={setScope}
        />
      ) : null}

      {data.length > 3 ? (
        <View className="mb-6">
          <Field
            value={search}
            onChangeText={setSearch}
            placeholder="Search subjects or module codes"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ) : null}

      {loading ? (
        <Loading label="Opening your library…" />
      ) : data.length === 0 ? (
        <EmptyState
          icon="folder-plus"
          title="Your library is empty"
          body="Upload a syllabus, lecture slides or notes. Notomi extracts the text on your device, then files it under the right subject automatically."
          action={<UploadButton label="Upload material" />}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={search.trim() ? 'search' : 'folder'}
          title={search.trim() ? 'No matches' : 'Nothing in this term'}
          body={
            search.trim()
              ? `Nothing in ${scopeName ? `“${scopeName}”` : 'your library'} matches “${search.trim()}”.`
              : 'No subjects are filed under this term yet. Assign them in the program planner, or switch to All.'
          }
          action={
            search.trim() ? undefined : (
              <Button label="Show all subjects" variant="secondary" onPress={() => setScope('all')} />
            )
          }
        />
      ) : (
        <CardGrid>
          {filtered.map((subject, index) => (
            <GridItem key={subject.id} index={index}>
              <SubjectCard subject={subject} onEdit={() => setEditing(subject)} />
            </GridItem>
          ))}
        </CardGrid>
      )}

      {data.length > 0 ? (
        <Text className="mt-8 text-xs leading-5 text-subtle">
          Documents are grouped by the module code Notomi finds in them. Uploading another file from
          the same course adds it to the existing folder.
        </Text>
      ) : null}

      <SubjectModal
        uid={uid}
        subject={editing === 'new' ? null : editing}
        visible={editing !== null}
        onClose={() => setEditing(null)}
        onCreated={(subjectId) => router.push(`/library/${subjectId}`)}
      />
    </ScreenScroll>
  );
}
