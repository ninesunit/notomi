import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { AddMaterialModal } from '@/components/AddMaterialModal';
import { AttendanceGuard } from '@/components/AcademicInsights';
import { AssignmentsPanel } from '@/components/Assignments';
import { LectureLogPanel } from '@/components/LectureLog';
import { ScreenScroll } from '@/components/ScreenScroll';
import { SubjectModal } from '@/components/SubjectModal';
import { Tabs, TabPanel, type Tab } from '@/components/Tabs';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PageHeader,
} from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection, useDocument } from '@/hooks/useFirestore';
import { formatDateTime } from '@/lib/dates';
import { formatChars } from '@/lib/format';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import type {
  Assignment,
  ClassBlock,
  LectureLog,
  Semester,
  SourceDocument,
  StudySession,
  Subject,
} from '@/lib/schema';
import { deleteMaterial, deleteSubject } from '@/services/ingestion';
import { getR2FileUrl } from '@/services/r2Storage';
import { describeLastStudied, formatMinutes, studyBySubject } from '@/services/sessions';
import { findActiveSemester } from '@/services/academicPlanner';

type TabId = 'sources' | 'tasks' | 'log';

export default function SubjectFolder({
  basePath = '/library',
  parentHref = '/library',
  readerPath,
}: {
  basePath?: string;
  parentHref?: string;
  readerPath?: string;
} = {}) {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const uid = useUid();
  const router = useRouter();
  const db = getDb();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<TabId>('sources');

  const subject = useDocument<Subject>(paths.subject(db, uid, subjectId), [uid, subjectId]);
  const documents = useCollection<SourceDocument>(
    query(paths.documents(db, uid, subjectId), orderBy('createdAt', 'desc')),
    [uid, subjectId]
  );
  const sessions = useCollection<StudySession>(paths.sessions(db, uid), [uid]);
  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const semesters = useCollection<Semester>(paths.semesters(db, uid), [uid]);

  // Subscribed here only for the tab counts. The panels open their own
  // listeners on the same queries, which the SDK serves from one watch.
  const assignments = useCollection<Assignment>(paths.assignments(db, uid, subjectId), [
    uid,
    subjectId,
  ]);
  const lectures = useCollection<LectureLog>(paths.lectures(db, uid, subjectId), [uid, subjectId]);

  const study = useMemo(
    () => studyBySubject(sessions.data).get(subjectId) ?? null,
    [sessions.data, subjectId]
  );

  const attendanceSemester = useMemo(
    () =>
      semesters.data.find((entry) => entry.id === subject.data?.semesterId) ??
      findActiveSemester(semesters.data),
    [semesters.data, subject.data?.semesterId]
  );

  /** Task 3 asks for modules grouped inside the folder. */
  const modules = useMemo(() => {
    const groups = new Map<string, SourceDocument[]>();
    for (const document of documents.data) {
      const key = document.moduleCode?.trim() || 'Ungrouped';
      const bucket = groups.get(key);
      if (bucket) bucket.push(document);
      else groups.set(key, [document]);
    }
    // "Ungrouped" always sorts last so real module codes lead.
    return [...groups.entries()].sort(([a], [b]) =>
      a === 'Ungrouped' ? 1 : b === 'Ungrouped' ? -1 : a.localeCompare(b)
    );
  }, [documents.data]);

  const totalChars = useMemo(
    () => documents.data.reduce((total, document) => total + (document.charCount ?? 0), 0),
    [documents.data]
  );

  async function removeDocument(document: SourceDocument) {
    setError(null);
    setRemoving(document.id);
    try {
      await deleteMaterial(uid, subjectId, document.id, document.r2FileKey || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoving(null);
    }
  }

  /**
   * Presigned URLs expire, so the link is minted on demand rather than stored.
   * A configured public bucket base short-circuits this inside getR2FileUrl.
   */
  async function openOriginal(document: SourceDocument) {
    setError(null);
    const pendingWindow =
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? window.open('about:blank', '_blank')
        : null;
    if (pendingWindow) pendingWindow.opener = null;
    try {
      const url = document.r2FileKey ? await getR2FileUrl(document.r2FileKey) : document.r2FileUrl;
      if (!url) throw new Error('This document has no stored original.');
      if (pendingWindow) pendingWindow.location.href = url;
      else await Linking.openURL(url);
    } catch (caught) {
      pendingWindow?.close();
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeSubject() {
    setError(null);
    setDeleting(true);
    try {
      await deleteSubject(uid, subjectId);
      router.replace(parentHref as never);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }

  if (subject.loading) {
    return (
      <ScreenScroll>
        <Loading label="Opening subject…" />
      </ScreenScroll>
    );
  }

  if (!subject.data) {
    return (
      <ScreenScroll>
        <EmptyState
          icon="folder"
          title="Subject not found"
          body="This folder may have been deleted."
          action={
            <Link href={parentHref} asChild>
              <Button label="Back to library" variant="secondary" />
            </Link>
          }
        />
      </ScreenScroll>
    );
  }

  const hasText = documents.data.some((document) => (document.charCount ?? 0) > 0);

  const TABS: Tab<TabId>[] = [
    {
      id: 'sources',
      label: 'Sources',
      icon: 'file-text',
      count: documents.data.length,
    },
    {
      id: 'tasks',
      label: 'Tutorials & assignments',
      icon: 'clipboard',
      // The badge counts what is still outstanding, not the total: a student
      // wants to know what is left, not what they have ever handed in.
      count: assignments.data.filter((row) => row.status !== 'done').length,
    },
    {
      id: 'log',
      label: 'Lecture log',
      icon: 'book-open',
      count: lectures.data.length,
    },
  ];

  return (
    <ScreenScroll>
      <Link href={parentHref} asChild>
        <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
          <Icon name="arrow-left" size={15} color="#6F6A5F" />
          <Text className="text-sm font-medium text-muted">Back to Knowledge</Text>
        </Pressable>
      </Link>

      {/* The subject colour and vector icon identify the folder at a glance. */}
      <View
        className="mb-5 h-20 w-full overflow-hidden rounded-2xl"
        style={{ backgroundColor: `${subject.data.color}1F` }}
      >
        <View className="h-1.5 w-full" style={{ backgroundColor: subject.data.color }} />
        <View className="flex-1 flex-row items-center gap-3 px-5">
          <Icon name="book-open" size={28} color={subject.data.color} />
          {subject.data.tag ? (
            <View
              className="rounded-full px-2.5 py-1"
              style={{ backgroundColor: `${subject.data.color}2E` }}
            >
              <Text className="text-xs font-semibold" style={{ color: subject.data.color }}>
                {subject.data.tag}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <PageHeader
        title={subject.data.name}
        subtitle={[
          subject.data.moduleCode,
          `${documents.data.length} ${documents.data.length === 1 ? 'source' : 'sources'}`,
          totalChars > 0 ? `${formatChars(totalChars)} of context` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <Link href={readerPath ?? `/reader/${subjectId}`} asChild>
              <Button label="Open Reader" icon="message-circle" size="sm" disabled={!hasText} />
            </Link>
            <Link href={`/study?subjectId=${subjectId}`} asChild>
              <Button
                label="Take Quiz"
                icon="zap"
                variant="secondary"
                size="sm"
                disabled={!hasText}
              />
            </Link>
            <IconButton icon="edit-2" label="Edit subject" onPress={() => setEditOpen(true)} />
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Something went wrong" body={error} />
        </View>
      ) : null}

      <AttendanceGuard
        uid={uid}
        subject={subject.data}
        classes={classes.data}
        semester={attendanceSemester}
      />

      {/* Study time is already logged against this subject by the focus timer
          and the study centre; this is where a student sees it back. */}
      <View className="mb-6 flex-row flex-wrap items-center gap-2">
        <View className="flex-row items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2">
          <Icon name="clock" size={13} color="#9A9488" />
          <Text className="text-sm font-bold text-ink">{formatMinutes(study?.minutes ?? 0)}</Text>
          <Text className="text-[13px] text-muted">studied</Text>
        </View>

        {study?.minutesThisWeek ? (
          <View className="flex-row items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-2">
            <Icon name="trending-up" size={13} color="#2E6F5E" />
            <Text className="text-sm font-bold text-pine">
              {formatMinutes(study.minutesThisWeek)}
            </Text>
            <Text className="text-[13px] text-muted">this week</Text>
          </View>
        ) : null}

        <Text className="text-[13px] text-subtle">
          {describeLastStudied(study?.lastStudied ?? null)}
        </Text>
      </View>

      <View className="mb-8 flex-row flex-wrap gap-2">
        <Button
          label="Add material"
          icon="upload-cloud"
          variant="secondary"
          size="sm"
          onPress={() => setAddOpen(true)}
        />
        <Link href={`/tasks?tab=focus&subjectId=${subjectId}`} asChild>
          <Button label="Study this" icon="target" variant="secondary" size="sm" />
        </Link>
        <Link href={`/knowledge/notes?subjectId=${subjectId}`} asChild>
          <Button label="New notebook" icon="notebook-pen" variant="secondary" size="sm" />
        </Link>
        <Link href={`/capture?subjectId=${subjectId}`} asChild>
          <Button label="Capture a photo" icon="camera" variant="secondary" size="sm" />
        </Link>
      </View>

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'sources' ? (
        <TabPanel id="sources">
          {documents.loading ? (
            <Loading label="Loading sources…" />
          ) : documents.data.length === 0 ? (
            <EmptyState
              icon="file-plus"
              title="No sources in this subject"
              body="Add lecture slides, notes or a syllabus and they will show up here."
            />
          ) : (
            <View className="gap-8">
              {modules.map(([moduleCode, moduleDocuments]) => (
                <View key={moduleCode} className="gap-3">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-xs font-bold uppercase tracking-wider text-muted">
                      {moduleCode}
                    </Text>
                    <View className="h-px flex-1 bg-line" />
                    <Text className="text-xs text-subtle">{moduleDocuments.length}</Text>
                  </View>

                  <View className="gap-3">
                    {moduleDocuments.map((document) => (
                      <Card key={document.id} className="gap-3">
                        <View className="flex-row items-start gap-3">
                          <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-lg bg-sand">
                            <Icon
                              name={document.mimeType?.includes('pdf') ? 'file-text' : 'file'}
                              size={15}
                              color="#6F6A5F"
                            />
                          </View>

                          {/* The whole row opens the note reader — the icons beside
                              it stay reserved for the destructive actions. */}
                          <Link href={`${basePath}/${subjectId}/${document.id}`} asChild>
                            <Pressable className="flex-1 gap-1">
                              <Text className="text-[15px] font-semibold leading-5 text-ink">
                                {document.fileName}
                              </Text>
                              <Text className="text-xs text-subtle">
                                {[
                                  formatDateTime(document.createdAt),
                                  document.charCount ? formatChars(document.charCount) : null,
                                  document.sizeBytes
                                    ? `${(document.sizeBytes / 1024 / 1024).toFixed(1)} MB`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </Text>
                            </Pressable>
                          </Link>

                          <View className="flex-row items-center">
                            {document.notes ? (
                              <View className="mr-1">
                                <Badge label="Notes" tone="pine" />
                              </View>
                            ) : null}
                            {document.r2FileKey || document.r2FileUrl ? (
                              <IconButton
                                icon="download"
                                label={`Open ${document.fileName}`}
                                onPress={() => void openOriginal(document)}
                              />
                            ) : null}
                            <IconButton
                              icon={removing === document.id ? 'loader' : 'trash-2'}
                              tone="rose"
                              label={`Remove ${document.fileName}`}
                              onPress={() => void removeDocument(document)}
                            />
                          </View>
                        </View>

                        {document.summary ? (
                          <Text className="text-sm leading-6 text-ink/75">{document.summary}</Text>
                        ) : null}

                        {document.error ? (
                          <Badge label="Analysed with warnings" tone="amber" />
                        ) : null}
                      </Card>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          )}

          <View className="mt-10 gap-3 border-t border-line pt-6">
            {confirmingDelete ? (
              <>
                <Notice
                  tone="rose"
                  title={`Delete “${subject.data.name}” and everything in it?`}
                  body={`This removes ${documents.data.length} source${
                    documents.data.length === 1 ? '' : 's'
                  }, their uploaded files, every note and saved chat, and any to-dos created from them. It cannot be undone.`}
                />
                <View className="flex-row items-center gap-2">
                  <Button
                    label={deleting ? 'Deleting…' : 'Yes, delete everything'}
                    variant="danger"
                    size="sm"
                    icon="trash-2"
                    loading={deleting}
                    disabled={deleting}
                    onPress={() => void removeSubject()}
                  />
                  <Button
                    label="Cancel"
                    variant="ghost"
                    size="sm"
                    disabled={deleting}
                    onPress={() => setConfirmingDelete(false)}
                  />
                </View>
              </>
            ) : (
              <View className="items-start">
                <Button
                  label="Delete subject"
                  variant="danger"
                  size="sm"
                  icon="trash-2"
                  onPress={() => setConfirmingDelete(true)}
                />
                <Text className="mt-2 text-xs text-subtle">
                  Removes this folder and everything derived from it — sources, notes, chats and
                  deadlines.
                </Text>
              </View>
            )}
          </View>
        </TabPanel>
      ) : tab === 'tasks' ? (
        <TabPanel id="tasks">
          <AssignmentsPanel uid={uid} subjectId={subjectId} subjectName={subject.data.name} />
        </TabPanel>
      ) : (
        <TabPanel id="log">
          <LectureLogPanel uid={uid} subjectId={subjectId} subjectName={subject.data.name} />
        </TabPanel>
      )}

      <AddMaterialModal
        subjectId={subjectId}
        subjectName={subject.data.name}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
      />

      <SubjectModal
        uid={uid}
        subject={subject.data}
        visible={editOpen}
        onClose={() => setEditOpen(false)}
      />
    </ScreenScroll>
  );
}
