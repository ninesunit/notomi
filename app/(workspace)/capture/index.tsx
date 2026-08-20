import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { paths } from '@/lib/paths';
import type { Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  captureImage,
  describeIngestError,
  processUploadedMaterial,
  stageLabel,
  type IngestStage,
} from '@/services/ingestion';

/**
 * Whiteboard capture.
 *
 * One screen, one job: photograph what is on the board and have it read and
 * filed before you have left the room. It is a PWA home-screen shortcut, so it
 * can be reached in one tap from outside the app — which is the only way a
 * capture tool gets used during a lecture.
 *
 * The subject sticks between visits, because the answer is almost always the
 * class you are sitting in.
 */

const LAST_SUBJECT_KEY = 'notomi:capture:subject';

function rememberSubject(subjectId: string | null): void {
  if (Platform.OS !== 'web') return;
  try {
    if (subjectId) localStorage.setItem(LAST_SUBJECT_KEY, subjectId);
    else localStorage.removeItem(LAST_SUBJECT_KEY);
  } catch {
    /* Private mode; the picker just starts empty next time. */
  }
}

function recallSubject(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return localStorage.getItem(LAST_SUBJECT_KEY);
  } catch {
    return null;
  }
}

export default function Capture() {
  const params = useLocalSearchParams<{ subjectId?: string }>();
  const uid = useUid();
  const db = getDb();
  const router = useRouter();

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );

  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [stage, setStage] = useState<IngestStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ documentId: string; warning?: string } | null>(null);

  // Restore the last subject once the list is in, and only if the URL did not
  // name one — a deep link from a subject page must win.
  useEffect(() => {
    if (params.subjectId || subjectId || subjects.loading) return;
    const remembered = recallSubject();
    if (remembered && subjects.data.some((subject) => subject.id === remembered)) {
      setSubjectId(remembered);
    } else if (subjects.data.length === 1) {
      setSubjectId(subjects.data[0].id);
    }
  }, [params.subjectId, subjectId, subjects.loading, subjects.data]);

  const subject = useMemo(
    () => subjects.data.find((candidate) => candidate.id === subjectId) ?? null,
    [subjects.data, subjectId]
  );

  const capture = useCallback(async () => {
    if (!subjectId) return;
    setError(null);
    setSaved(null);

    let picked;
    try {
      picked = await captureImage();
    } catch (caught) {
      setError(describeIngestError(caught));
      return;
    }
    if (picked.length === 0) return;

    rememberSubject(subjectId);
    setStage('reading');

    try {
      const result = await processUploadedMaterial(picked[0], subjectId, uid, (next) =>
        setStage(next)
      );
      setSaved({ documentId: result.documentId, warning: result.warning });
    } catch (caught) {
      setError(describeIngestError(caught));
    } finally {
      setStage(null);
    }
  }, [subjectId, uid]);

  const busy = stage !== null;

  return (
    <ScreenScroll maxWidth={640}>
      <PageHeader
        title="Capture"
        subtitle="Photograph a whiteboard or a slide. Notomi reads the text and files it under the subject."
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save that capture" body={error} />
        </View>
      ) : null}

      {subjects.loading ? (
        <Loading label="Loading your subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="camera"
          title="No subjects yet"
          body="Create a subject first — a capture has to land somewhere."
          action={
            <Link href="/knowledge" asChild>
              <Button label="Go to library" variant="secondary" />
            </Link>
          }
        />
      ) : (
        <View className="gap-6">
          <View className="gap-2">
            <Text className="text-sm font-medium text-muted">File it under</Text>
            <View className="flex-row flex-wrap gap-1.5">
              {subjects.data.map((candidate) => {
                const active = subjectId === candidate.id;
                return (
                  <Pressable
                    key={candidate.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    disabled={busy}
                    onPress={() => {
                      setSubjectId(candidate.id);
                      rememberSubject(candidate.id);
                    }}
                    className={`flex-row items-center gap-2 rounded-xl border px-3 py-2.5 ${
                      active ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
                    }`}
                  >
                    <Icon name="book-open" size={15} color={candidate.color} />
                    <Text
                      className={`text-[13px] font-semibold ${
                        active ? 'text-accent' : 'text-muted'
                      }`}
                    >
                      {candidate.moduleCode || candidate.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* The capture target: deliberately huge, because it is pressed with
              a thumb, one-handed, while looking at a board. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take a photo"
            disabled={!subjectId || busy}
            onPress={() => void capture()}
            className={`items-center justify-center gap-3 rounded-3xl border-2 border-dashed py-16 ${
              !subjectId || busy
                ? 'border-line bg-sand/40'
                : 'border-accent/40 bg-accent-soft'
            }`}
          >
            <View
              className={`h-20 w-20 items-center justify-center rounded-full ${
                busy ? 'bg-sand' : 'bg-ink'
              }`}
            >
              <Icon name="camera" size={30} color={busy ? '#9A9488' : '#F7F5EE'} />
            </View>

            <Text className="text-base font-semibold text-ink">
              {busy ? stageLabel(stage, 'image') : 'Take a photo'}
            </Text>
            <Text className="max-w-xs text-center text-[13px] leading-5 text-muted">
              {!subjectId
                ? 'Pick a subject first.'
                : busy
                  ? 'Keep this screen open — reading the image takes a few seconds.'
                  : `Saved to ${subject?.name ?? 'your subject'} with the text extracted.`}
            </Text>
          </Pressable>

          {saved ? (
            <Card className="gap-3 bg-pine-soft">
              <View className="flex-row items-center gap-2">
                <Icon name="check-circle" size={16} tone="pine" />
                <Text className="text-[15px] font-semibold text-ink">Captured</Text>
              </View>
              <Text className="text-sm leading-5 text-ink/75">
                {saved.warning ??
                  `Filed under ${subject?.name ?? 'your subject'}. Open it to read the extracted text or generate notes.`}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Open it"
                  icon="file-text"
                  size="sm"
                  onPress={() => router.push(`/knowledge/subject/${subjectId}/${saved.documentId}`)}
                />
                <Button
                  label="Capture another"
                  icon="camera"
                  variant="secondary"
                  size="sm"
                  onPress={() => void capture()}
                />
              </View>
            </Card>
          ) : null}

          <Text className="text-xs leading-5 text-subtle">
            Add Notomi to your home screen and this screen becomes a one-tap shortcut.
          </Text>
        </View>
      )}
    </ScreenScroll>
  );
}
