import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { CardGrid, GridItem, SubjectCard } from '@/components/SubjectCard';
import { UploadButton } from '@/components/UploadButton';
import { EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';

/** Root of the library: one folder per subject, live from Firestore. */
export default function Library() {
  const uid = useUid();
  const [search, setSearch] = useState('');

  const { data, loading, error } = useCollection<Subject>(
    query(paths.subjects(getDb(), uid), orderBy('updatedAt', 'desc')),
    [uid]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data;
    return data.filter((subject) =>
      `${subject.name} ${subject.moduleCode ?? ''}`.toLowerCase().includes(needle)
    );
  }, [data, search]);

  const totalSources = useMemo(
    () => data.reduce((total, subject) => total + (subject.documentCount ?? 0), 0),
    [data]
  );

  return (
    <ScreenScroll>
      <PageHeader
        title="Library"
        subtitle={
          data.length
            ? `${data.length} ${data.length === 1 ? 'subject' : 'subjects'} · ${totalSources} ${
                totalSources === 1 ? 'source' : 'sources'
              }`
            : 'Every document you upload is filed into a subject folder.'
        }
        actions={<UploadButton />}
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not load your library" body={error.message} />
        </View>
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
          icon="search"
          title="No matches"
          body={`Nothing in your library matches “${search.trim()}”.`}
        />
      ) : (
        <CardGrid>
          {filtered.map((subject) => (
            <GridItem key={subject.id}>
              <SubjectCard subject={subject} />
            </GridItem>
          ))}
        </CardGrid>
      )}

      {data.length > 0 ? (
        <Text className="mt-8 text-xs leading-5 text-subtle">
          Documents are grouped by the module code Gemini finds in them. Uploading another file from
          the same course adds it to the existing folder.
        </Text>
      ) : null}
    </ScreenScroll>
  );
}
