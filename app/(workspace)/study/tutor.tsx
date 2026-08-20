import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { Icon, useTones } from '@/components/Icon';
import { getDocs, orderBy, query } from 'firebase/firestore';
import { Markdown } from '@/components/Markdown';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { buildContext, gradeAnswer, generateOpenQuestions } from '@/lib/ai';
import { paths } from '@/lib/paths';
import type { AnswerGrade, OpenQuestion, SourceDocument, Subject } from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { logSession } from '@/services/sessions';
import { recordMiss } from '@/lib/srs';

/**
 * Active recall: the student writes the answer, Gemini marks it.
 *
 * Two modes over the same machinery. The tutor asks one question at a time and
 * follows up on the answer, so the thread adapts; the exam runs a fixed paper
 * end to end and only reports at the finish, because seeing the mark after
 * every question is not what an exam feels like.
 */

type Mode = 'socratic' | 'exam';
type Phase = 'choosing' | 'generating' | 'active' | 'results';

type Attempt = {
  question: OpenQuestion;
  answer: string;
  grade: AnswerGrade;
};

const EXAM_LENGTH = 6;

export default function Tutor() {
  const tones = useTones();
  const params = useLocalSearchParams<{ subjectId?: string; mode?: string }>();
  const uid = useUid();
  const db = getDb();

  const [mode, setMode] = useState<Mode>(params.mode === 'exam' ? 'exam' : 'socratic');
  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [phase, setPhase] = useState<Phase>('choosing');
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState('');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [grading, setGrading] = useState(false);
  const [lastGrade, setLastGrade] = useState<AnswerGrade | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Kept out of state: it is prompt input, and changing it must not re-render. */
  const context = useRef('');
  const startedAt = useRef<number>(0);

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );
  const subject = subjects.data.find((candidate) => candidate.id === subjectId) ?? null;

  const start = useCallback(
    async (targetId: string, nextMode: Mode) => {
      setError(null);
      setPhase('generating');
      setMode(nextMode);
      setSubjectId(targetId);
      setAttempts([]);
      setLastGrade(null);
      setDraft('');
      setIndex(0);

      try {
        const snapshot = await getDocs(
          query(paths.documents(db, uid, targetId), orderBy('createdAt', 'asc'))
        );
        const built = buildContext(
          snapshot.docs.map((document) => {
            const data = document.data() as SourceDocument;
            return { title: data.fileName || data.title, text: data.rawText ?? '' };
          })
        );

        if (!built) {
          setError('This subject has no readable text yet. Upload a document first.');
          setPhase('choosing');
          return;
        }

        context.current = built;
        const generated = await generateOpenQuestions(built, {
          count: nextMode === 'exam' ? EXAM_LENGTH : 5,
          style: nextMode,
        });

        setQuestions(generated);
        startedAt.current = Date.now();
        setPhase('active');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase('choosing');
      }
    },
    [db, uid]
  );

  const submit = useCallback(async () => {
    const answer = draft.trim();
    const question = questions[index];
    if (!answer || !question || grading) return;

    setGrading(true);
    setError(null);

    try {
      const grade = await gradeAnswer(context.current, question, answer, {
        socratic: mode === 'socratic',
      });

      setAttempts((previous) => [...previous, { question, answer, grade }]);

      // A weak answer is the same signal as a missed quiz question, so it feeds
      // the same spaced-repetition pile.
      if (grade.score < 60 && subjectId) {
        void recordMiss(uid, subjectId, subject?.name ?? null, {
          question: question.question,
          options: [question.modelAnswer || 'See the model answer'],
          correctAnswerIndex: 0,
          explanation: grade.whatWasMissing || question.modelAnswer,
          concept: question.concept ?? undefined,
        }).catch(() => undefined);
      }

      if (mode === 'socratic') {
        setLastGrade(grade);
        setDraft('');
        // A follow-up extends the thread; without one, move to the next planned
        // question, and end when those run out.
        if (grade.followUp) {
          setQuestions((previous) => {
            const next = [...previous];
            next.splice(index + 1, 0, {
              question: grade.followUp as string,
              modelAnswer: '',
              concept: question.concept,
            });
            return next;
          });
        }
      } else {
        setDraft('');
        if (index + 1 >= questions.length) finish([...attempts, { question, answer, grade }]);
        else setIndex(index + 1);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGrading(false);
    }
  }, [attempts, draft, grading, index, mode, questions, subject?.name, subjectId, uid]);

  const finish = useCallback(
    (finalAttempts: Attempt[]) => {
      setAttempts(finalAttempts);
      setPhase('results');

      const minutes = Math.round((Date.now() - startedAt.current) / 60_000);
      if (minutes >= 1 && subjectId) {
        void logSession(uid, {
          minutes,
          mode: mode === 'exam' ? 'exam' : 'tutor',
          subjectId,
          subjectName: subject?.name ?? null,
        }).catch(() => undefined);
      }
    },
    [mode, subject?.name, subjectId, uid]
  );

  const average = useMemo(
    () =>
      attempts.length === 0
        ? 0
        : Math.round(attempts.reduce((total, attempt) => total + attempt.grade.score, 0) / attempts.length),
    [attempts]
  );

  /* ---------------------------- generating --------------------------- */

  if (phase === 'generating') {
    return (
      <ScreenScroll maxWidth={780}>
        <Loading
          label={
            mode === 'exam'
              ? 'Writing a practice paper from your material…'
              : 'Preparing your first question…'
          }
        />
      </ScreenScroll>
    );
  }

  /* ------------------------------ active ----------------------------- */

  if (phase === 'active' && questions[index]) {
    const question = questions[index];

    return (
      <ScreenScroll maxWidth={780}>
        <View className="mb-6 flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="End this session"
            onPress={() => (attempts.length > 0 ? finish(attempts) : setPhase('choosing'))}
            className="h-9 w-9 items-center justify-center rounded-lg bg-sand"
          >
            <Icon name="x" size={15} tone="muted" />
          </Pressable>

          <View className="flex-1 gap-1.5">
            <Text className="text-xs font-medium text-muted">
              {mode === 'exam'
                ? `Question ${index + 1} of ${questions.length}`
                : `Exchange ${attempts.length + 1}`}
              {subject ? ` · ${subject.name}` : ''}
            </Text>
            <View className="h-1 w-full overflow-hidden rounded-full bg-sand">
              <View
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${
                    mode === 'exam'
                      ? (index / questions.length) * 100
                      : Math.min(100, (attempts.length / 6) * 100)
                  }%`,
                }}
              />
            </View>
          </View>

          {mode === 'socratic' && attempts.length > 0 ? (
            <Button label="Finish" variant="secondary" size="sm" onPress={() => finish(attempts)} />
          ) : null}
        </View>

        {error ? (
          <View className="mb-6">
            <Notice title="Could not mark that answer" body={error} />
          </View>
        ) : null}

        {/* In Socratic mode the previous verdict stays on screen: the follow-up
            only makes sense next to what prompted it. */}
        {mode === 'socratic' && lastGrade ? (
          <View className="mb-6">
            <GradeCard grade={lastGrade} compact />
          </View>
        ) : null}

        <Card className="mb-5 gap-4">
          {question.concept ? <Badge label={question.concept} tone="accent" /> : null}
          <Text className="text-[19px] font-semibold leading-7 text-ink">{question.question}</Text>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Answer in your own words — a few sentences is fine."
            placeholderTextColor={tones.subtle}
            multiline
            editable={!grading}
            className="min-h-[140px] rounded-xl border border-line bg-paper px-4 py-3 text-[15px] leading-6 text-ink"
            style={{ textAlignVertical: 'top' }}
          />

          <View className="flex-row items-center gap-3">
            <Button
              label={grading ? 'Marking…' : 'Submit answer'}
              icon="send"
              loading={grading}
              disabled={grading || !draft.trim()}
              onPress={() => void submit()}
            />
            <Text className="flex-1 text-xs text-subtle">
              {mode === 'exam'
                ? 'Marks are shown at the end, like a real paper.'
                : 'You will get a mark and a follow-up straight away.'}
            </Text>
          </View>
        </Card>
      </ScreenScroll>
    );
  }

  /* ----------------------------- results ----------------------------- */

  if (phase === 'results') {
    const weakest = [...attempts].sort((a, b) => a.grade.score - b.grade.score).slice(0, 3);

    return (
      <ScreenScroll maxWidth={780}>
        <BackLink />

        <PageHeader
          title={`${average}%`}
          subtitle={
            average >= 75
              ? 'Strong. You can explain this material, not just recognise it.'
              : average >= 50
                ? 'A working understanding with real gaps. The weakest answers are below.'
                : 'Worth rereading the source before the next attempt.'
          }
        />

        <View className="mb-8 h-2 w-full overflow-hidden rounded-full bg-sand">
          <View
            className={`h-full rounded-full ${
              average >= 75 ? 'bg-pine' : average >= 50 ? 'bg-amber' : 'bg-rose'
            }`}
            style={{ width: `${average}%` }}
          />
        </View>

        {weakest.length > 0 && average < 90 ? (
          <View className="mb-8 gap-3">
            <Text className="text-lg font-semibold tracking-tight text-ink">
              Where you lost marks
            </Text>
            <Text className="text-sm text-muted">
              Anything under 60% has been added to your weak concepts for spaced review.
            </Text>
            {weakest.map((attempt, i) => (
              <Card key={i} className="gap-3">
                <View className="flex-row items-start gap-3">
                  <View
                    className={`rounded-lg px-2 py-1 ${
                      attempt.grade.score >= 75
                        ? 'bg-pine-soft'
                        : attempt.grade.score >= 50
                          ? 'bg-amber-soft'
                          : 'bg-rose-soft'
                    }`}
                  >
                    <Text
                      className={`text-xs font-bold ${
                        attempt.grade.score >= 75
                          ? 'text-pine'
                          : attempt.grade.score >= 50
                            ? 'text-amber'
                            : 'text-rose'
                      }`}
                    >
                      {attempt.grade.score}%
                    </Text>
                  </View>
                  <Text className="flex-1 text-[15px] font-medium leading-6 text-ink">
                    {attempt.question.question}
                  </Text>
                </View>

                {attempt.grade.whatWasMissing ? (
                  <View className="gap-1">
                    <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                      What was missing
                    </Text>
                    <Markdown source={attempt.grade.whatWasMissing} />
                  </View>
                ) : null}
              </Card>
            ))}
          </View>
        ) : (
          <View className="mb-8">
            <Notice tone="pine" title="Clean run" body="Nothing new added to your weak concepts." />
          </View>
        )}

        <View className="flex-row flex-wrap gap-2">
          <Button
            label={mode === 'exam' ? 'Another paper' : 'Another session'}
            icon="refresh-cw"
            onPress={() => subjectId && void start(subjectId, mode)}
          />
          <Button
            label={mode === 'exam' ? 'Switch to tutor mode' : 'Sit a practice exam'}
            icon={mode === 'exam' ? 'message-circle' : 'file-text'}
            variant="secondary"
            onPress={() => subjectId && void start(subjectId, mode === 'exam' ? 'socratic' : 'exam')}
          />
          <Button label="Done" variant="ghost" onPress={() => setPhase('choosing')} />
        </View>
      </ScreenScroll>
    );
  }

  /* ----------------------------- chooser ----------------------------- */

  return (
    <ScreenScroll maxWidth={780}>
      <BackLink />

      <PageHeader
        title={mode === 'exam' ? 'Exam simulator' : 'AI tutor'}
        subtitle={
          mode === 'exam'
            ? 'A practice paper written from your material, marked question by question.'
            : 'Notomi asks, you explain, and it follows up on what you say.'
        }
      />

      <View className="mb-6 flex-row gap-2">
        <ModeChip
          label="Tutor"
          hint="Adaptive, one question at a time"
          active={mode === 'socratic'}
          onPress={() => setMode('socratic')}
        />
        <ModeChip
          label="Exam"
          hint={`${EXAM_LENGTH} questions, marked at the end`}
          active={mode === 'exam'}
          onPress={() => setMode('exam')}
        />
      </View>

      {error ? (
        <View className="mb-6">
          <Notice title="Could not start" body={error} />
        </View>
      ) : null}

      <Text className="mb-4 text-lg font-semibold tracking-tight text-ink">Pick a subject</Text>

      {subjects.loading ? (
        <Loading label="Loading subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="message-circle"
          title="Nothing to be examined on yet"
          body="Upload a document first — every question comes strictly from your own material."
          action={
            <Link href="/library" asChild>
              <Button label="Go to library" variant="secondary" />
            </Link>
          }
        />
      ) : (
        <View className="gap-3">
          {subjects.data.map((candidate) => {
            const empty = (candidate.documentCount ?? 0) === 0;
            return (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                disabled={empty}
                onPress={() => void start(candidate.id, mode)}
                className={`flex-row items-center gap-4 rounded-2xl border border-line bg-surface p-4 ${
                  empty ? 'opacity-50' : ''
                }`}
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${candidate.color}1A` }}
                >
                  <Icon name="book-open" size={16} color={candidate.color} />
                </View>
                <View className="flex-1 gap-1">
                  <Text className="text-[15px] font-semibold text-ink">{candidate.name}</Text>
                  <Text className="text-xs text-muted">
                    {candidate.documentCount ?? 0}{' '}
                    {(candidate.documentCount ?? 0) === 1 ? 'source' : 'sources'}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} tone="subtle" />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScreenScroll>
  );
}

function ModeChip({
  label,
  hint,
  active,
  onPress,
}: {
  label: string;
  hint: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`flex-1 gap-0.5 rounded-xl border px-4 py-3 ${
        active ? 'border-ink bg-ink' : 'border-line bg-surface'
      }`}
    >
      <Text className={`text-sm font-semibold ${active ? 'text-paper' : 'text-ink'}`}>{label}</Text>
      <Text className={`text-[11px] ${active ? 'text-paper/70' : 'text-subtle'}`}>{hint}</Text>
    </Pressable>
  );
}

function GradeCard({ grade, compact = false }: { grade: AnswerGrade; compact?: boolean }) {
  const tone = grade.score >= 75 ? 'pine' : grade.score >= 50 ? 'amber' : 'rose';
  const surface = { pine: 'bg-pine-soft', amber: 'bg-amber-soft', rose: 'bg-rose-soft' }[tone];
  const text = { pine: 'text-pine', amber: 'text-amber', rose: 'text-rose' }[tone];

  return (
    <View className={`gap-3 rounded-2xl p-4 ${surface}`}>
      <View className="flex-row items-center gap-3">
        <Text className={`text-2xl font-bold ${text}`}>{grade.score}%</Text>
        <Text className="flex-1 text-sm leading-5 text-ink/80">{grade.verdict}</Text>
      </View>

      {!compact || grade.whatWentWell ? (
        <View className="gap-1">
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
            What went well
          </Text>
          <Text className="text-sm leading-6 text-ink/80">{grade.whatWentWell || '—'}</Text>
        </View>
      ) : null}

      {grade.whatWasMissing ? (
        <View className="gap-1">
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
            What was missing
          </Text>
          <ScrollView className="max-h-52">
            <Markdown source={grade.whatWasMissing} />
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function BackLink() {
  return (
    <Link href="/knowledge" asChild>
      <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
        <Icon name="arrow-left" size={15} tone="muted" />
        <Text className="text-sm font-medium text-muted">Back to Knowledge</Text>
      </Pressable>
    </Link>
  );
}
