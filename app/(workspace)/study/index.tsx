import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { getDocs, orderBy, query, where } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Badge, Button, Card, EmptyState, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { buildContext, generateQuiz } from '@/lib/ai';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import { isDue, recordHit, recordMiss } from '@/lib/srs';
import type { QuizQuestion, SourceDocument, Subject, WeakConcept } from '@/lib/schema';

type Phase = 'choosing' | 'generating' | 'active' | 'results';

export default function StudyCenter() {
  const params = useLocalSearchParams<{ subjectId?: string }>();
  const uid = useUid();
  const db = getDb();

  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('updatedAt', 'desc')),
    [uid]
  );
  const weak = useCollection<WeakConcept>(paths.weakConcepts(db, uid), [uid]);

  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [phase, setPhase] = useState<Phase>('choosing');
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState(false);

  const subject = useMemo(
    () => subjects.data.find((candidate) => candidate.id === subjectId) ?? null,
    [subjects.data, subjectId]
  );

  const dueConcepts = useMemo(() => weak.data.filter((concept) => isDue(concept)), [weak.data]);

  const start = useCallback(
    async (targetId: string, focusWeak: boolean) => {
      setError(null);
      setPhase('generating');
      setReviewMode(focusWeak);
      setSubjectId(targetId);

      try {
        // Fetched on demand rather than subscribed: source text is large and
        // only needed at the moment a quiz is generated.
        const snapshot = await getDocs(
          query(paths.documents(db, uid, targetId), orderBy('createdAt', 'asc'))
        );
        const context = buildContext(
          snapshot.docs.map((document) => {
            const data = document.data() as SourceDocument;
            return { title: data.fileName || data.title, text: data.rawText ?? '' };
          })
        );

        if (!context) {
          setError('This subject has no readable text yet. Upload a document first.');
          setPhase('choosing');
          return;
        }

        const focusConcepts = focusWeak
          ? weak.data
              .filter((concept) => concept.subjectId === targetId)
              .map((concept) => concept.concept)
              .slice(0, 12)
          : undefined;

        const generated = await generateQuiz(context, { count: 10, focusConcepts });
        setQuestions(generated);
        setAnswers(new Array(generated.length).fill(null));
        setIndex(0);
        setPicked(null);
        setPhase('active');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase('choosing');
      }
    },
    [db, uid, weak.data]
  );

  const answer = useCallback(
    (choice: number) => {
      if (picked !== null || !subjectId) return;
      setPicked(choice);
      setAnswers((previous) => {
        const next = [...previous];
        next[index] = choice;
        return next;
      });

      const question = questions[index];
      const correct = choice === question.correctAnswerIndex;

      // Fire-and-forget: the SRS record must never stall the quiz UI.
      void (correct
        ? recordHit(uid, subjectId, question)
        : recordMiss(uid, subjectId, subject?.name ?? null, question)
      ).catch(() => undefined);
    },
    [picked, index, questions, subjectId, subject?.name, uid]
  );

  function advance() {
    if (index + 1 >= questions.length) {
      setPhase('results');
      return;
    }
    setIndex(index + 1);
    setPicked(null);
  }

  function reset() {
    setPhase('choosing');
    setQuestions([]);
    setAnswers([]);
    setIndex(0);
    setPicked(null);
  }

  /* ------------------------------- Quiz ------------------------------- */

  if (phase === 'generating') {
    return (
      <ScreenScroll>
        <Loading
          label={
            reviewMode
              ? 'Building a review session from what you got wrong…'
              : 'Reading your sources and writing 10 questions…'
          }
        />
      </ScreenScroll>
    );
  }

  if (phase === 'active' && questions.length > 0) {
    const question = questions[index];
    const correct = picked === question.correctAnswerIndex;

    return (
      <ScreenScroll maxWidth={760}>
        <View className="mb-6 flex-row items-center gap-3">
          <Pressable onPress={reset} className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
            <Feather name="x" size={15} color="#6F6A5F" />
          </Pressable>
          <View className="flex-1 gap-1.5">
            <Text className="text-xs font-medium text-muted">
              Question {index + 1} of {questions.length}
              {subject ? ` · ${subject.name}` : ''}
            </Text>
            <View className="h-1 w-full overflow-hidden rounded-full bg-sand">
              <View
                className="h-full rounded-full bg-accent"
                style={{ width: `${((index + (picked !== null ? 1 : 0)) / questions.length) * 100}%` }}
              />
            </View>
          </View>
        </View>

        <Card className="gap-5">
          {question.concept ? <Badge label={question.concept} tone="accent" /> : null}

          <Text className="text-[19px] font-semibold leading-7 text-ink">{question.question}</Text>

          <View className="gap-2.5">
            {question.options.map((option, optionIndex) => {
              const isCorrect = optionIndex === question.correctAnswerIndex;
              const isPicked = optionIndex === picked;
              const revealed = picked !== null;

              const surface = !revealed
                ? 'border-line bg-surface'
                : isCorrect
                  ? 'border-pine/40 bg-pine-soft'
                  : isPicked
                    ? 'border-rose/40 bg-rose-soft'
                    : 'border-line bg-surface opacity-60';

              return (
                <Pressable
                  key={optionIndex}
                  accessibilityRole="button"
                  disabled={revealed}
                  onPress={() => answer(optionIndex)}
                  className={`flex-row items-center gap-3 rounded-xl border px-4 py-3.5 ${surface}`}
                >
                  <View
                    className={`h-6 w-6 items-center justify-center rounded-full ${
                      revealed && isCorrect
                        ? 'bg-pine'
                        : revealed && isPicked
                          ? 'bg-rose'
                          : 'bg-sand'
                    }`}
                  >
                    {revealed && (isCorrect || isPicked) ? (
                      <Feather name={isCorrect ? 'check' : 'x'} size={12} color="#FFFFFF" />
                    ) : (
                      <Text className="text-[11px] font-bold text-muted">
                        {String.fromCharCode(65 + optionIndex)}
                      </Text>
                    )}
                  </View>
                  <Text className="flex-1 text-[15px] leading-6 text-ink">{option}</Text>
                </Pressable>
              );
            })}
          </View>

          {picked !== null ? (
            <View className="gap-4 border-t border-line pt-4">
              <View className="gap-1.5">
                <Text className={`text-sm font-bold ${correct ? 'text-pine' : 'text-rose'}`}>
                  {correct ? 'Correct' : 'Not quite'}
                </Text>
                {question.explanation ? (
                  <Text className="text-sm leading-6 text-ink/75">{question.explanation}</Text>
                ) : null}
                {!correct ? (
                  <Text className="mt-1 text-xs text-subtle">
                    Saved to your weak concepts for review.
                  </Text>
                ) : null}
              </View>
              <Button
                label={index + 1 >= questions.length ? 'See results' : 'Next question'}
                onPress={advance}
                className="self-start"
              />
            </View>
          ) : null}
        </Card>
      </ScreenScroll>
    );
  }

  /* ------------------------------ Results ----------------------------- */

  if (phase === 'results') {
    const score = answers.reduce<number>(
      (total, choice, i) => total + (choice === questions[i]?.correctAnswerIndex ? 1 : 0),
      0
    );
    const percent = Math.round((score / questions.length) * 100);
    const missed = questions.filter((q, i) => answers[i] !== q.correctAnswerIndex);

    return (
      <ScreenScroll maxWidth={760}>
        <PageHeader
          title={`${score} / ${questions.length}`}
          subtitle={
            percent >= 80
              ? 'Strong session. These concepts are sticking.'
              : percent >= 50
                ? 'Solid start. The misses below are worth another pass.'
                : 'Worth rereading the source material before the next attempt.'
          }
        />

        <View className="mb-8 h-2 w-full overflow-hidden rounded-full bg-sand">
          <View
            className={`h-full rounded-full ${percent >= 80 ? 'bg-pine' : percent >= 50 ? 'bg-amber' : 'bg-rose'}`}
            style={{ width: `${percent}%` }}
          />
        </View>

        {missed.length > 0 ? (
          <View className="mb-8 gap-3">
            <Text className="text-lg font-semibold tracking-tight text-ink">
              Added to your weak concepts
            </Text>
            {missed.map((question, i) => (
              <Card key={i} className="gap-2">
                <Text className="text-[15px] font-medium leading-6 text-ink">{question.question}</Text>
                <Text className="text-sm text-pine">
                  {question.options[question.correctAnswerIndex]}
                </Text>
                {question.explanation ? (
                  <Text className="text-sm leading-6 text-muted">{question.explanation}</Text>
                ) : null}
              </Card>
            ))}
          </View>
        ) : (
          <View className="mb-8">
            <Notice tone="pine" title="Clean sweep" body="Nothing new added to your weak concepts." />
          </View>
        )}

        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Another quiz"
            icon="refresh-cw"
            onPress={() => subjectId && void start(subjectId, false)}
          />
          {missed.length > 0 ? (
            <Button
              label="Drill my weak spots"
              icon="target"
              variant="secondary"
              onPress={() => subjectId && void start(subjectId, true)}
            />
          ) : null}
          <Button label="Done" variant="ghost" onPress={reset} />
        </View>
      </ScreenScroll>
    );
  }

  /* ------------------------------ Chooser ----------------------------- */

  return (
    <ScreenScroll>
      <PageHeader
        title="Study Center"
        subtitle="Quizzes written from your own uploads. Anything you miss comes back on a schedule."
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not build the quiz" body={error} />
        </View>
      ) : null}

      {dueConcepts.length > 0 ? (
        <Card className="mb-8 gap-4 border-accent/25 bg-accent-soft">
          <View className="flex-row items-start gap-3">
            <Feather name="target" size={18} color="#B4552D" style={{ marginTop: 2 }} />
            <View className="flex-1 gap-1">
              <Text className="text-[15px] font-semibold text-ink">
                {dueConcepts.length} concept{dueConcepts.length === 1 ? '' : 's'} due for review
              </Text>
              <Text className="text-sm leading-5 text-ink/70">
                {dueConcepts
                  .slice(0, 4)
                  .map((concept) => concept.concept)
                  .join(' · ')}
                {dueConcepts.length > 4 ? ` and ${dueConcepts.length - 4} more` : ''}
              </Text>
            </View>
          </View>
          <Button
            label="Start review session"
            size="sm"
            className="self-start"
            onPress={() => {
              const target = dueConcepts[0].subjectId;
              void start(target, true);
            }}
          />
        </Card>
      ) : null}

      <Text className="mb-4 text-lg font-semibold tracking-tight text-ink">Pick a subject</Text>

      {subjects.loading ? (
        <Loading label="Loading subjects…" />
      ) : subjects.data.length === 0 ? (
        <EmptyState
          icon="zap"
          title="Nothing to quiz yet"
          body="Upload a document first — quizzes are written strictly from your own material."
          action={
            <Link href="/library" asChild>
              <Button label="Go to library" variant="secondary" />
            </Link>
          }
        />
      ) : (
        <View className="gap-3">
          {subjects.data.map((candidate) => {
            const candidateWeak = weak.data.filter((c) => c.subjectId === candidate.id).length;
            const empty = (candidate.documentCount ?? 0) === 0;

            return (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                disabled={empty}
                onPress={() => void start(candidate.id, false)}
                className={`flex-row items-center gap-4 rounded-2xl border border-line bg-surface p-4 ${
                  empty ? 'opacity-50' : ''
                }`}
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${candidate.color || '#B4552D'}1A` }}
                >
                  <Feather name="book-open" size={16} color={candidate.color || '#B4552D'} />
                </View>

                <View className="flex-1 gap-1">
                  <Text className="text-[15px] font-semibold text-ink">{candidate.name}</Text>
                  <Text className="text-xs text-muted">
                    {candidate.documentCount ?? 0}{' '}
                    {(candidate.documentCount ?? 0) === 1 ? 'source' : 'sources'}
                    {candidateWeak > 0 ? ` · ${candidateWeak} weak concept${candidateWeak === 1 ? '' : 's'}` : ''}
                  </Text>
                </View>

                <Feather name="chevron-right" size={16} color="#9A9488" />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScreenScroll>
  );
}
