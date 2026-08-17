import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { getDocs, orderBy, query } from 'firebase/firestore';
import { Icon } from '@/components/Icon';
import { KnowledgeTabs, type KnowledgeTab } from '@/components/KnowledgeTabs';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  materialKind,
  MATERIAL_KINDS,
  sortMaterials,
  type MaterialKind,
} from '@/services/materials';
import Library from '../library';

const VALID_TABS: KnowledgeTab[] = ['folders', 'reader', 'vault'];

export default function KnowledgeHub() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const router = useRouter();
  const tab = VALID_TABS.includes(params.tab as KnowledgeTab)
    ? (params.tab as KnowledgeTab)
    : 'folders';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value={tab} />
      <View className="min-h-0 flex-1">
        {tab === 'folders' ? (
          <Library basePath="/knowledge/subject" />
        ) : tab === 'reader' ? (
          <ReaderDirectory />
        ) : (
          <DocumentVault
            onOpen={(subjectId, documentId) =>
              router.push(`/knowledge/subject/${subjectId}/${documentId}` as never)
            }
          />
        )}
      </View>
    </View>
  );
}

function ReaderDirectory() {
  const uid = useUid();
  const subjects = useCollection<Subject>(
    query(paths.subjects(getDb(), uid), orderBy('updatedAt', 'desc')),
    [uid]
  );
  const readable = subjects.data.filter((subject) => (subject.documentCount ?? 0) > 0);

  return (
    <ScreenScroll>
      <PageHeader
        title="Open Reader"
        subtitle="Choose a course and ask questions grounded in its uploaded material."
      />
      {subjects.loading ? (
        <Loading label="Finding readable courses…" />
      ) : readable.length === 0 ? (
        <EmptyState
          icon="book-open"
          title="No readable material yet"
          body="Upload a document into a course folder, then return here to open its reader."
          action={
            <Link href="/knowledge?tab=folders" asChild>
              <Button label="Open course folders" icon="folder-kanban" />
            </Link>
          }
        />
      ) : (
        <View className="gap-3">
          {readable.map((subject) => (
            <Link key={subject.id} href={`/knowledge/reader/${subject.id}`} asChild>
              <Pressable
                accessibilityRole="link"
                className="flex-row items-center gap-3 rounded-2xl border border-line bg-surface p-4"
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${subject.color}20` }}
                >
                  <Icon name="book-open" size={17} color={subject.color} />
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px] font-semibold text-ink">{subject.name}</Text>
                  <Text className="text-xs text-muted">
                    {[subject.moduleCode, `${subject.documentCount} sources`].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} color="#9A9488" />
              </Pressable>
            </Link>
          ))}
        </View>
      )}
    </ScreenScroll>
  );
}

type VaultRow = { subject: Subject; document: SourceDocument };

/**
 * Every original, filed under the course it belongs to.
 *
 * A flat newest-first list was fine for a dozen files and useless for two
 * hundred: after a bulk upload of a semester's tutorials, the one sheet you
 * want is somewhere in the middle of every other course's slides. So the vault
 * groups by subject the way the library does, and filters on what a file is —
 * "the tutorials for Research Methods" is the question actually being asked.
 */
function DocumentVault({ onOpen }: { onOpen: (subjectId: string, documentId: string) => void }) {
  const uid = useUid();
  const subjects = useCollection<Subject>(paths.subjects(getDb(), uid), [uid]);
  const [rows, setRows] = useState<VaultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<MaterialKind | 'all'>('all');
  /** Subjects the student has folded away; everything starts open. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (subjects.loading) return;
    let live = true;
    setLoading(true);
    setError(null);
    void Promise.all(
      subjects.data.map(async (subject) => {
        const snapshot = await getDocs(paths.documents(getDb(), uid, subject.id));
        return snapshot.docs.map(
          (entry) => ({ subject, document: { id: entry.id, ...entry.data() } as SourceDocument })
        );
      })
    )
      .then((groups) => live && setRows(groups.flat()))
      .catch((caught) => live && setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [uid, subjects.loading, subjects.data]);

  const visible = useMemo(
    () => (kind === 'all' ? rows : rows.filter((row) => materialKind(row.document) === kind)),
    [rows, kind]
  );

  /** How many files of each kind, so a filter that would empty the screen says so. */
  const counts = useMemo(() => {
    const tally = {} as Record<MaterialKind, number>;
    for (const row of rows) {
      const key = materialKind(row.document);
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, [rows]);

  /** One section per course, biggest first, each ordered the way the library orders. */
  const sections = useMemo(() => {
    const bySubject = new Map<string, VaultRow[]>();
    for (const row of visible) {
      const bucket = bySubject.get(row.subject.id);
      if (bucket) bucket.push(row);
      else bySubject.set(row.subject.id, [row]);
    }

    return [...bySubject.values()]
      .map((entries) => ({
        subject: entries[0].subject,
        documents: sortMaterials(entries.map((entry) => entry.document)),
      }))
      .sort(
        (a, b) =>
          b.documents.length - a.documents.length || a.subject.name.localeCompare(b.subject.name)
      );
  }, [visible]);

  const totalBytes = useMemo(
    () => rows.reduce((sum, row) => sum + (row.document.sizeBytes ?? 0), 0),
    [rows]
  );

  return (
    <ScreenScroll>
      <PageHeader
        title="Document Vault"
        subtitle={`${rows.length} files · ${(totalBytes / 1024 / 1024).toFixed(1)} MB across every course`}
      />
      {error ? <Notice title="Could not load the vault" body={error} /> : null}

      {rows.length > 0 ? (
        <View className="mb-4 flex-row flex-wrap gap-2">
          {(['all', ...MATERIAL_KINDS.map((entry) => entry.key)] as const).map((key) => {
            const label =
              key === 'all'
                ? `All ${rows.length}`
                : `${MATERIAL_KINDS.find((entry) => entry.key === key)?.label} ${counts[key] ?? 0}`;
            // A filter that would show nothing is not offered.
            if (key !== 'all' && !counts[key as MaterialKind]) return null;

            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: kind === key }}
                onPress={() => setKind(key)}
                className={`rounded-full border px-3 py-1.5 ${
                  kind === key ? 'border-ink bg-ink' : 'border-line bg-surface'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${kind === key ? 'text-paper' : 'text-muted'}`}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {loading ? (
        <Loading label="Opening the vault…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="folder-kanban"
          title="Your vault is empty"
          body="General notes and course material appear here after the universal importer processes them."
        />
      ) : (
        <View className="gap-5">
          {sections.map(({ subject, documents }) => {
            const shut = collapsed[subject.id] === true;

            return (
              <View key={subject.id} className="gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !shut }}
                  accessibilityLabel={`${subject.name}, ${documents.length} files`}
                  onPress={() =>
                    setCollapsed((current) => ({ ...current, [subject.id]: !shut }))
                  }
                  className="flex-row items-center gap-2.5"
                >
                  <View
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: subject.color }}
                  />
                  <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>
                    {subject.name}
                  </Text>
                  <Text className="text-xs text-muted">
                    {subject.moduleCode ? `${subject.moduleCode} · ` : ''}
                    {documents.length}
                  </Text>
                  <View className="flex-1" />
                  <Icon name={shut ? 'chevron-right' : 'chevron-down'} size={15} color="#9A9488" />
                </Pressable>

                {shut ? null : (
                  <View className="gap-2">
                    {documents.map((document) => (
                      <Pressable
                        key={document.id}
                        accessibilityRole="button"
                        onPress={() => onOpen(subject.id, document.id)}
                      >
                        <Card className="flex-row items-center gap-3 py-3.5">
                          <Icon name="file-text" size={16} color={subject.color} />
                          <View className="flex-1 gap-0.5">
                            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                              {document.fileName}
                            </Text>
                            <Text className="text-xs text-muted" numberOfLines={1}>
                              {MATERIAL_KINDS.find(
                                (entry) => entry.key === materialKind(document)
                              )?.label ?? 'Other'}
                              {document.chapter ? ` · ${document.chapter}` : ''}
                            </Text>
                          </View>
                          <Icon name="chevron-right" size={15} color="#9A9488" />
                        </Card>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </ScreenScroll>
  );
}
