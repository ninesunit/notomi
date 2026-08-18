import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { AddMaterialModal } from '@/components/AddMaterialModal';
import { DriveDropZone } from '@/components/DriveDropZone';
import { Sheet } from '@/components/Sheet';
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
import { UNGROUPED, groupMaterials, moveMaterialToSubject, renameChapter } from '@/services/materials';
import { weekOf } from '@/services/teachingPlan';
import { isDriveConfigured, pickFromDrive } from '@/lib/driveUtils';
import { rememberPickedFiles } from '@/services/driveStorage';
import {
  materialFilesFromWeb,
  processUploadedMaterial,
  validateMaterialBatch,
} from '@/services/ingestion';
import { feedback } from '@/lib/sound';
import { paths } from '@/lib/paths';
import type {
  Assignment,
  ClassBlock,
  LectureLog,
  Semester,
  SourceDocument,
  StudySession,
  Subject,
  TeachingPlanWeek,
} from '@/lib/schema';
import { deleteMaterial, deleteSubject } from '@/services/ingestion';
import { getR2FileUrl } from '@/services/r2Storage';
import { describeLastStudied, formatMinutes, studyBySubject } from '@/services/sessions';
import { findActiveSemester } from '@/services/academicPlanner';
import { DEFAULT_SUBJECT_ICON } from '@/lib/schema';

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
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [filing, setFiling] = useState<string | null>(null);

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

  /**
   * Modules grouped inside the folder, ordered the way the lecturer numbered
   * them. Both the grouping and the order can be overridden by the student —
   * see services/materials.
   */
  const modules = useMemo(() => groupMaterials(documents.data), [documents.data]);

  const totalChars = useMemo(
    () => documents.data.reduce((total, document) => total + (document.charCount ?? 0), 0),
    [documents.data]
  );

  /**
   * Files the student already has in Drive.
   *
   * The picker is the only way a drive.file app can reach a file it did not
   * create — choosing one *is* the permission grant — so this is how material
   * added to Drive outside Notomi gets in.
   */
  async function syncFromDrive() {
    setError(null);
    setDriveBusy('Opening your Drive…');
    try {
      const picked = await pickFromDrive();
      if (picked.length === 0) return;
      setDriveBusy(`Linking ${picked.length} file${picked.length === 1 ? '' : 's'}…`);
      await rememberPickedFiles(uid, subjectId, picked);
      feedback('success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setDriveBusy(null);
    }
  }

  /** Dropped files take the ordinary ingest route, so nothing about them is special. */
  async function acceptDropped(files: File[]) {
    setError(null);
    try {
      const materials = materialFilesFromWeb(files);
      validateMaterialBatch(materials);
      for (let index = 0; index < materials.length; index += 1) {
        setDriveBusy(
          `Uploading ${materials[index].name} (${index + 1} of ${materials.length})…`
        );
        await processUploadedMaterial(materials[index], subjectId, uid);
      }
      feedback('success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setDriveBusy(null);
    }
  }

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
          <Icon
            name={(subject.data.icon ?? DEFAULT_SUBJECT_ICON) as never}
            size={28}
            color={subject.data.color}
          />
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

      <ThisWeekPanel
        uid={uid}
        subjectId={subjectId}
        semester={attendanceSemester ?? null}
      />

      {driveBusy ? (
        <View className="mb-3 flex-row items-center gap-2 rounded-xl bg-sand px-3 py-2.5">
          <Icon name="upload-cloud" size={13} color="#6F6A5F" />
          <Text className="flex-1 text-xs font-medium text-ink">{driveBusy}</Text>
        </View>
      ) : null}

      <View className="mb-8 flex-row flex-wrap gap-2">
        <Button
          label="Add material"
          icon="upload-cloud"
          variant="secondary"
          size="sm"
          onPress={() => setAddOpen(true)}
        />
        {isDriveConfigured() ? (
          <Button
            label="Sync from Drive"
            icon="refresh-cw"
            variant="secondary"
            size="sm"
            loading={Boolean(driveBusy)}
            disabled={Boolean(driveBusy)}
            onPress={() => void syncFromDrive()}
          />
        ) : null}
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
                  <ChapterHeading
                    name={moduleCode}
                    count={moduleDocuments.length}
                    onRename={(next) =>
                      renameChapter(uid, subjectId, moduleDocuments, next).catch((caught) =>
                        setError(caught instanceof Error ? caught.message : String(caught))
                      )
                    }
                  />

                  <View className="gap-3">
                    {moduleDocuments.map((document) => (
                      <Card key={document.id} className="gap-3">
                        {/* Wraps rather than squeezing. Filenames are long and
                            the controls beside them are fixed width, so without
                            this the title column collapses on a phone and sets
                            one word per line — the same fault the to-do rows
                            had. */}
                        <View className="flex-row flex-wrap items-start gap-3">
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
                            <Pressable className="min-w-0 flex-1 gap-1" style={{ minWidth: 200 }}>
                              <Text className="text-[15px] font-semibold leading-5 text-ink">
                                {document.fileName}
                              </Text>
                              <Text className="text-xs text-subtle">
                                {[
                                  // Where the original actually lives, so a
                                  // student can tell at a glance that Drive is
                                  // holding their work rather than guess.
                                  document.driveFileId ? 'In your Drive' : null,
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
                            {/* Only in the vault: everywhere else the file is
                                already where the student put it. */}
                            {subject.data?.isVault ? (
                              <IconButton
                                icon={filing === document.id ? 'loader' : 'folder-plus'}
                                label={`File ${document.fileName} into a subject`}
                                onPress={() => setFiling(document.id)}
                              />
                            ) : null}
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

      <FileIntoSubjectSheet
        uid={uid}
        fromSubjectId={subjectId}
        documentId={filing}
        onClose={() => setFiling(null)}
        onError={setError}
      />

      <DriveDropZone
        onFiles={acceptDropped}
        label={`Drop files to add them to ${subject.data.name}`}
      />

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

/**
 * A chapter title the student can correct.
 *
 * The model frequently cannot tell which chapter a bare slide deck belongs to,
 * and "Ungrouped" is a label the app chose rather than one the student agreed
 * to. Renaming edits every file in the group at once, because that is what a
 * student means by renaming a chapter.
 */
function ChapterHeading({
  name,
  count,
  onRename,
}: {
  name: string;
  count: number;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name === UNGROUPED ? '' : name);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) onRename(next);
  }

  if (editing) {
    return (
      <View className="flex-row items-center gap-2">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholder="Chapter name"
          placeholderTextColor="#9A9488"
          onSubmitEditing={commit}
          onBlur={commit}
          className="flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save chapter name"
          onPress={commit}
          className="h-8 w-8 items-center justify-center rounded-lg bg-ink"
        >
          <Icon name="check" size={14} color="#F7F5EE" />
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-2">
      <Text className="text-xs font-bold uppercase tracking-wider text-muted">{name}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Rename ${name}`}
        onPress={() => {
          setDraft(name === UNGROUPED ? '' : name);
          setEditing(true);
        }}
        className="h-6 w-6 items-center justify-center rounded"
      >
        <Icon name="pencil" size={12} color="#9A9488" />
      </Pressable>
      <View className="h-px flex-1 bg-line" />
      <Text className="text-xs text-subtle">{count}</Text>
    </View>
  );
}

/**
 * Puts an unfiled document where it belongs.
 *
 * The dashboard no longer invents a subject from a title the model guessed, so
 * anything it could not place waits in the vault instead. This is the one tap
 * that ends that — which is the whole reason guessing was worth giving up.
 */
function FileIntoSubjectSheet({
  uid,
  fromSubjectId,
  documentId,
  onClose,
  onError,
}: {
  uid: string;
  fromSubjectId: string;
  documentId: string | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const db = getDb();
  const subjects = useCollection<Subject>(paths.subjects(db, uid), [uid]);
  const [moving, setMoving] = useState<string | null>(null);

  const choices = useMemo(
    () => subjects.data.filter((entry) => !entry.isVault && entry.id !== fromSubjectId),
    [subjects.data, fromSubjectId]
  );

  async function move(target: Subject) {
    if (!documentId) return;
    setMoving(target.id);
    try {
      await moveMaterialToSubject(uid, fromSubjectId, target.id, documentId);
      feedback('success');
      onClose();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
      feedback('error');
    } finally {
      setMoving(null);
    }
  }

  return (
    <Sheet
      visible={Boolean(documentId)}
      onClose={onClose}
      title="File into a subject"
      icon="folder-plus"
      maxHeight={420}
    >
      <Text className="text-sm leading-5 text-muted">
        Notomi could not tell which course this belongs to, so it kept it here rather than making a
        folder up. Choose where it goes.
      </Text>

      {choices.length === 0 ? (
        <Text className="text-sm text-subtle">
          No subjects yet. Create one from your Library and it will appear here.
        </Text>
      ) : (
        <View className="gap-1.5">
          {choices.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              disabled={Boolean(moving)}
              onPress={() => void move(entry)}
              className="flex-row items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-3"
            >
              <View
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: entry.color || '#B4552D' }}
              />
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                  {entry.name}
                </Text>
                {entry.moduleCode ? (
                  <Text className="text-xs text-subtle">{entry.moduleCode}</Text>
                ) : null}
              </View>
              <Icon
                name={moving === entry.id ? 'loader' : 'chevron-right'}
                size={15}
                color="#9A9488"
              />
            </Pressable>
          ))}
        </View>
      )}
    </Sheet>
  );
}


/**
 * What this course is covering right now.
 *
 * A teaching plan is a table of week numbers; a student opening their subject
 * on a Tuesday wants the one row that applies today. The week is computed from
 * the term rather than stored, so correcting the academic calendar moves this
 * without re-importing anything.
 */
function ThisWeekPanel({
  uid,
  subjectId,
  semester,
}: {
  uid: string;
  subjectId: string;
  semester: Semester | null;
}) {
  const db = getDb();
  const weeks = useCollection<TeachingPlanWeek>(paths.teachingPlan(db, uid, subjectId), [
    uid,
    subjectId,
  ]);

  const current = useMemo(() => weekOf(semester), [semester]);
  const row = useMemo(
    () => weeks.data.find((entry) => entry.week === current) ?? null,
    [weeks.data, current]
  );

  if (weeks.loading || weeks.data.length === 0) return null;

  return (
    <Card className="mb-6 gap-2">
      <View className="flex-row items-center gap-2">
        <Icon name="calendar" size={14} color="#2E6F5E" />
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          {current ? `Week ${current}` : 'Teaching plan'}
        </Text>
        <View className="h-px flex-1 bg-line" />
        <Text className="text-xs text-subtle">{weeks.data.length} weeks</Text>
      </View>

      {row ? (
        <>
          <Text className="text-[15px] font-semibold leading-5 text-ink">{row.topic}</Text>
          {row.activity ? <Text className="text-xs text-muted">{row.activity}</Text> : null}
          {row.assessment ? (
            <View className="mt-1 flex-row items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5">
              <Icon name="alert-circle" size={12} color="#B4552D" />
              <Text className="flex-1 text-xs font-medium text-accent">{row.assessment}</Text>
            </View>
          ) : null}
        </>
      ) : (
        <Text className="text-sm text-subtle">
          {current
            ? 'Nothing scheduled for this week.'
            : 'Import an academic calendar to see which week you are in.'}
        </Text>
      )}
    </Card>
  );
}
