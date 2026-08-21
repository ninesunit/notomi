import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { getDocs, orderBy, query } from 'firebase/firestore';
import { Icon, useTones } from '@/components/Icon';
import { KnowledgeTabs, type KnowledgeTab } from '@/components/KnowledgeTabs';
import { ReviewDeck } from '@/components/ReviewDeck';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, EmptyState, Loading, Notice, PageHeader, Touchable } from '@/components/ui';
import {
  canShareFiles,
  downloadFiles,
  ShareCancelledError,
  shareFiles,
  deviceShareSupported,
} from '@/lib/deviceShare';
import { feedback } from '@/lib/sound';
import { filesForSharing } from '@/services/documentExport';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { SourceDocument, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  materialKind,
  MATERIAL_KINDS,
  sortForVault,
  type MaterialKind,
} from '@/services/materials';
import Library from '../library';
import { subjectInk, subjectTint } from '@/lib/color';

const VALID_TABS: KnowledgeTab[] = ['folders', 'reader', 'review', 'vault'];

export default function KnowledgeHub() {
  // `view` is accepted alongside `tab` because /reel redirects here with it,
  // and a link that was shared before the feed was removed should still work.
  const params = useLocalSearchParams<{ tab?: string; view?: string }>();
  const router = useRouter();
  const requested = (params.tab ?? params.view) as KnowledgeTab | undefined;
  const tab = requested && VALID_TABS.includes(requested) ? requested : 'folders';

  return (
    <View className="min-h-0 flex-1 bg-paper">
      <KnowledgeTabs value={tab} />
      <View className="min-h-0 flex-1">
        {tab === 'folders' ? (
          <Library basePath="/knowledge/subject" />
        ) : tab === 'reader' ? (
          <ReaderDirectory />
        ) : tab === 'review' ? (
          <ReviewDeck />
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
                  style={{ backgroundColor: subjectTint(subject.color, 0.125) }}
                >
                  <Icon name="book-open" size={17} color={subjectInk(subject.color)} />
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="text-[15px] font-semibold text-ink">{subject.name}</Text>
                  <Text className="text-xs text-muted">
                    {[subject.moduleCode, `${subject.documentCount} sources`].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} tone="subtle" />
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
  const tones = useTones();
  const uid = useUid();
  const subjects = useCollection<Subject>(paths.subjects(getDb(), uid), [uid]);
  const [rows, setRows] = useState<VaultRow[]>([]);
  /**
   * Selection mode is opt-in. Tapping a file in the vault opens it, which is
   * what a student wants ninety-nine times in a hundred; turning rows into
   * checkboxes by default would tax every one of those to serve the hundredth.
   */
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [sharing, setSharing] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
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
        documents: sortForVault(entries.map((entry) => entry.document)),
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

  const chosenRows = useMemo(
    () => rows.filter((row) => chosen[row.document.id]),
    [rows, chosen]
  );

  const leavePicking = useCallback(() => {
    setPicking(false);
    setChosen({});
    setShareNote(null);
  }, []);

  /**
   * Hands the selected originals to the operating system.
   *
   * Nothing is uploaded and no link is minted — the bytes come down from the
   * student's own storage and go straight into the OS sheet, which is what
   * makes WhatsApp, AirDrop and "Save to Files" all work without Notomi
   * integrating with any of them.
   *
   * Falls back to a download (zipped past one file) wherever file sharing is
   * unsupported, which is most desktop browsers.
   */
  const shareChosen = useCallback(async () => {
    if (chosenRows.length === 0) return;
    setSharing(true);
    setShareNote(null);
    try {
      const { files, missing } = await filesForSharing(
        chosenRows.map((row) => row.document),
        (done, total) => setShareNote(`Preparing ${done} of ${total}…`)
      );

      if (files.length === 0) {
        setShareNote('None of those files could be fetched. Check your connection and try again.');
        return;
      }

      const note = missing.length > 0 ? `${missing.length} file${missing.length === 1 ? '' : 's'} could not be fetched and were left out.` : null;

      if (canShareFiles(files)) {
        await shareFiles(files, files.length === 1 ? files[0].name : 'Notomi files');
        feedback('success');
        setShareNote(note);
        if (!note) leavePicking();
        return;
      }

      await downloadFiles(files);
      feedback('success');
      setShareNote(note ?? 'This browser cannot open a share sheet, so the files were downloaded instead.');
    } catch (error) {
      // Dismissing the sheet is a decision, not a failure.
      if (error instanceof ShareCancelledError) return;
      setShareNote(error instanceof Error ? error.message : String(error));
    } finally {
      setSharing(false);
    }
  }, [chosenRows, leavePicking]);

  return (
    <ScreenScroll>
      <PageHeader
        title="Document Vault"
        subtitle={`${rows.length} files · ${(totalBytes / 1024 / 1024).toFixed(1)} MB across every course`}
      />
      {error ? <Notice title="Could not load the vault" body={error} /> : null}

      {rows.length > 0 ? (
        <View className="mb-4 flex-row items-center gap-2">
          <Button
            label={picking ? 'Cancel' : 'Select files'}
            icon={picking ? 'x' : 'check-square'}
            variant="secondary"
            size="sm"
            onPress={() => (picking ? leavePicking() : setPicking(true))}
          />
          {picking ? (
            <Text className="text-xs text-muted">
              {chosenRows.length === 0
                ? 'Tap files to choose them'
                : `${chosenRows.length} selected`}
            </Text>
          ) : null}
        </View>
      ) : null}

      {shareNote ? <Notice title="Sharing" body={shareNote} /> : null}

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
                  <Icon name={shut ? 'chevron-right' : 'chevron-down'} size={15} tone="subtle" />
                </Pressable>

                {shut ? null : (
                  <View className="gap-2">
                    {documents.map((document) => {
                      const ticked = chosen[document.id] === true;
                      return (
                      <Touchable
                        key={document.id}
                        accessibilityRole={picking ? 'checkbox' : 'button'}
                        accessibilityState={picking ? { checked: ticked } : undefined}
                        accessibilityLabel={document.fileName}
                        onPress={() =>
                          picking
                            ? setChosen((current) => ({ ...current, [document.id]: !ticked }))
                            : onOpen(subject.id, document.id)
                        }
                      >
                        <Card className={`flex-row items-center gap-3 py-3.5 ${ticked ? 'border-ink' : ''}`}>
                          <Icon
                            name={picking ? (ticked ? 'check-circle-2' : 'circle') : 'file-text'}
                            size={16}
                            color={picking && ticked ? subjectInk(subject.color) : picking ? tones.subtle : subjectInk(subject.color)}
                          />
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
                          {picking ? null : (
                            <Icon name="chevron-right" size={15} tone="subtle" />
                          )}
                        </Card>
                      </Touchable>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {picking && chosenRows.length > 0 ? (
        <View className="mt-5 gap-2 rounded-2xl border border-line bg-surface p-4">
          <Text className="text-sm font-semibold text-ink">
            {chosenRows.length} file{chosenRows.length === 1 ? '' : 's'} ready
          </Text>
          <Text className="text-xs text-muted">
            {deviceShareSupported()
              ? 'Opens your device’s share sheet — WhatsApp, AirDrop, Mail, Save to Files. Notomi never uploads them anywhere.'
              : 'This browser has no share sheet, so these will download instead. Several files arrive as one zip.'}
          </Text>
          <View className="flex-row flex-wrap gap-2 pt-1">
            <Button
              label={deviceShareSupported() ? 'Share' : 'Download'}
              icon="share-2"
              size="sm"
              loading={sharing}
              onPress={() => void shareChosen()}
            />
            <Button
              label="Clear"
              variant="ghost"
              size="sm"
              disabled={sharing}
              onPress={() => setChosen({})}
            />
          </View>
        </View>
      ) : null}
    </ScreenScroll>
  );
}
