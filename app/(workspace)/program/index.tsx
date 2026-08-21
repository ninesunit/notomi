import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { ProgramMap } from '@/components/ProgramMap';
import { AcademicCalendarImport } from '@/components/AcademicCalendarImport';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Sheet } from '@/components/Sheet';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Loading,
  Notice,
  PageHeader,
} from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import {
  calculateGpa,
  GRADE_OPTIONS,
  knownTerms,
  TERM_SUGGESTIONS,
  type ClassBlock,
  type Semester,
  type StudySession,
  type Subject,
} from '@/lib/schema';
import { studyBySubject } from '@/services/sessions';
import type { CalendarImportOutcome } from '@/services/academicPlanner';
import {
  assignSubject,
  createSemester,
  deleteSemester,
  moveSemester,
  setCurrentSemester,
  setSubjectCredits,
  setSubjectGrade,
  sortSemesters,
  updateSemester,
  type SemesterInput,
} from '@/services/program';
import { subjectInk, subjectTint } from '@/lib/color';
import { PHONE } from '@/lib/breakpoints';
import { GRADE_SCALES, useGradeScale } from '@/lib/academicRules';

/**
 * The program planner: the degree seen as a sequence of semesters, each holding
 * a set of subjects with credit hours and grades.
 *
 * Subjects are created by the ingestion pipeline, not here — this screen files
 * them into a semester and records what they are worth.
 */
export default function Program() {
  const uid = useUid();
  const db = getDb();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Semester | 'new' | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { width } = useWindowDimensions();
  const phone = width < PHONE;
  const [calendarMessage, setCalendarMessage] = useState<string | null>(null);
  /** The map is the default: structure first, editing second. */
  const [view, setView] = useState<'map' | 'planner'>('map');

  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );
  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('name', 'asc')),
    [uid]
  );
  const classes = useCollection<ClassBlock>(paths.classes(db, uid), [uid]);
  const sessions = useCollection<StudySession>(paths.sessions(db, uid), [uid]);

  const study = useMemo(() => studyBySubject(sessions.data), [sessions.data]);
  const ordered = useMemo(() => sortSemesters(semesters.data), [semesters.data]);
  const unassigned = useMemo(
    () =>
      subjects.data.filter(
        (subject) => !subject.semesterId || !ordered.some((s) => s.id === subject.semesterId)
      ),
    [subjects.data, ordered]
  );

  const overall = useMemo(() => calculateGpa(subjects.data), [subjects.data]);

  const run = useCallback(async (action: Promise<unknown>) => {
    setError(null);
    try {
      await action;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const save = useCallback(
    async (input: SemesterInput) => {
      if (editing === 'new') await createSemester(uid, input, semesters.data);
      else if (editing) await updateSemester(uid, editing.id, input);
      setEditing(null);
    },
    [editing, uid, semesters.data]
  );

  const loading = semesters.loading || subjects.loading;

  const calendarImported = useCallback((outcome: CalendarImportOutcome) => {
    setCalendarMessage(
      `${outcome.created} term${outcome.created === 1 ? '' : 's'} added and ${outcome.updated} updated.${
        outcome.currentTerm ? ` ${outcome.currentTerm} is active now.` : ''
      }`
    );
  }, []);

  return (
    <ScreenScroll>
      <PageHeader
        title="Term Management"
        subtitle={
          ordered.length
            ? `${ordered.length} ${ordered.length === 1 ? 'term' : 'terms'} · ${
                overall.credits
              } credit hours planned`
            : 'Create term boundaries, set dates and assign each subject to its active teaching period.'
        }
        actions={
          /*
            One action on a phone, three on a desktop.

            "Import academic calendar" is twenty-six characters of button, and
            beside two others it came to seven hundred points on a three
            hundred and ninety point screen — "New term" ended up off the edge
            entirely. Both of the others are things a student does once a term;
            New term is the one they came here for.
          */
          phone ? (
            <>
              <Button label="New term" icon="plus" size="sm" onPress={() => setEditing('new')} />
              <IconButton
                icon="more-horizontal"
                label="More term actions"
                onPress={() => setMoreOpen(true)}
              />
            </>
          ) : (
            <>
              <Link href="/program/gpa" asChild>
                <Button label="GPA calculator" icon="trending-up" variant="secondary" size="sm" />
              </Link>
              <Button
                label="Import academic calendar"
                icon="calendar"
                variant="secondary"
                size="sm"
                onPress={() => setCalendarOpen(true)}
              />
              <Button label="New term" icon="plus" size="sm" onPress={() => setEditing('new')} />
            </>
          )
        }
      />

      <Sheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="Term actions"
        icon="layers"
        variant="compact"
      >
        <View className="gap-2">
          <Link href="/program/gpa" asChild>
            <Button
              label="GPA calculator"
              icon="trending-up"
              variant="secondary"
              onPress={() => setMoreOpen(false)}
            />
          </Link>
          <Button
            label="Import academic calendar"
            icon="calendar"
            variant="secondary"
            onPress={() => {
              setMoreOpen(false);
              setCalendarOpen(true);
            }}
          />
        </View>
      </Sheet>

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save that change" body={error} />
        </View>
      ) : null}

      {calendarMessage ? (
        <View className="mb-6">
          <Notice tone="pine" title="Academic calendar anchored" body={calendarMessage} />
        </View>
      ) : null}

      {semesters.error ? (
        <View className="mb-6">
          <Notice title="Could not load your program" body={semesters.error.message} />
        </View>
      ) : null}

      {loading ? (
        <Loading label="Loading your program…" />
      ) : (
        <View className="gap-6">
          {ordered.length > 0 ? <OverviewBar subjects={subjects.data} semesters={ordered} /> : null}

          {ordered.length > 0 ? (
            <View className="flex-row gap-1.5">
              <ViewChip label="Map" icon="git-merge" active={view === 'map'} onPress={() => setView('map')} />
              <ViewChip
                label="Planner"
                icon="list"
                active={view === 'planner'}
                onPress={() => setView('planner')}
              />
            </View>
          ) : null}

          {view === 'map' && ordered.length > 0 ? (
            <ProgramMap
              semesters={ordered}
              subjects={subjects.data}
              classes={classes.data}
              study={study}
            />
          ) : null}

          {ordered.length === 0 ? (
            <EmptyState
              icon="layers"
              title="No terms yet"
              body="Add a term, then file your subjects into it. Notomi uses credit hours and grades to keep a running GPA."
              action={<Button label="Add your first term" icon="plus" onPress={() => setEditing('new')} />}
            />
          ) : view === 'map' ? null : (
            ordered.map((semester, index) => (
              <SemesterCard
                key={semester.id}
                semester={semester}
                subjects={subjects.data.filter((subject) => subject.semesterId === semester.id)}
                canMoveUp={index > 0}
                canMoveDown={index < ordered.length - 1}
                onEdit={() => setEditing(semester)}
                onDelete={() => void run(deleteSemester(uid, semester.id, subjects.data))}
                onMakeCurrent={() => void run(setCurrentSemester(uid, semester.id, ordered))}
                onMove={(direction) => void run(moveSemester(uid, ordered, semester.id, direction))}
                onCredits={(subjectId, credits) => void run(setSubjectCredits(uid, subjectId, credits))}
                onGrade={(subjectId, grade) => void run(setSubjectGrade(uid, subjectId, grade))}
                allSemesters={ordered}
                onMoveSubject={(subjectId, target) =>
                  void run(assignSubject(uid, subjectId, target))
                }
              />
            ))
          )}

          {unassigned.length > 0 && view === 'planner' ? (
            <UnassignedShelf
              subjects={unassigned}
              semesters={ordered}
              onAssign={(subjectId, semester) =>
                void run(assignSubject(uid, subjectId, semester))
              }
            />
          ) : null}
        </View>
      )}

      <SemesterModal
        semester={editing}
        existingCount={semesters.data.length}
        usedTerms={knownTerms(semesters.data)}
        onSave={(input) => void run(save(input))}
        onClose={() => setEditing(null)}
      />
      <AcademicCalendarImport
        visible={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        uid={uid}
        semesters={semesters.data}
        onImported={calendarImported}
      />
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function OverviewBar({ subjects, semesters }: { subjects: Subject[]; semesters: Semester[] }) {
  const { width } = useWindowDimensions();
  /** Below this the three stats cannot sit side by side at full size. */
  const tight = width < 640;
  const overall = calculateGpa(subjects);
  const current = semesters.find((semester) => semester.isCurrent);
  const currentSubjects = current
    ? subjects.filter((subject) => subject.semesterId === current.id)
    : [];
  const currentGpa = calculateGpa(currentSubjects);

  // A target set on the current semester is the one worth showing; falling back
  // to any target would compare this term's work against another term's goal.
  const target = current?.gpaTarget ?? null;

  return (
    <Card className={`bg-sand/60 ${tight ? 'gap-3 py-3' : 'gap-5'}`}>
      {/*
        Three stats at 140 points wide with 28-point numbers wrap to three rows
        on a phone — roughly a quarter of the screen spent on numbers a student
        glances at. Side by side they cost one row.

        But three across 390 points is 130 each, and the third one carries a
        term name: "Year 2 · Trime…", "6 subjects · 24 cr…". Two on the first
        line and the term on its own, full width, is the same one-glance row
        without the ellipses.
      */}
      <View
        className={
          tight ? 'flex-row flex-wrap items-stretch gap-y-3' : 'flex-row flex-wrap gap-x-10 gap-y-5'
        }
      >
        <Stat
          tight={tight}
          label="Cumulative GPA"
          value={overall.gpa === null ? '—' : overall.gpa.toFixed(2)}
          hint={overall.graded > 0 ? `${overall.graded} graded credits` : 'No grades recorded yet'}
        />
        <Stat
          tight={tight}
          label="Credit hours"
          value={String(overall.credits)}
          hint="Across all semesters"
        />
        <Stat
          tight={tight}
          wide={tight}
          label={current ? current.name : 'Current semester'}
          value={currentGpa.gpa === null ? '—' : currentGpa.gpa.toFixed(2)}
          hint={
            current
              ? `${currentSubjects.length} ${currentSubjects.length === 1 ? 'subject' : 'subjects'} · ${currentGpa.credits} credits`
              : 'Mark a semester as current'
          }
        />
      </View>

      {target ? <TargetBar gpa={overall.gpa} target={target} /> : null}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tight = false,
  wide = false,
}: {
  label: string;
  wide?: boolean;
  value: string;
  hint: string;
  /** Side by side in one row, for a phone. */
  tight?: boolean;
}) {
  if (tight) {
    /*
     * `wide` takes the whole line rather than a third of it. A term is named,
     * not measured, and a name does not survive a 130-point column.
     */
    return (
      <View
        className={
          wide
            ? 'w-full min-w-0 gap-0.5 border-t border-line pt-2.5'
            : 'min-w-0 flex-1 gap-0.5 border-l border-line px-2 first:border-l-0 first:pl-0'
        }
      >
        <Text
          className="text-[9px] font-semibold uppercase tracking-wider text-muted"
          numberOfLines={1}
        >
          {label}
        </Text>
        <View className={wide ? 'flex-row items-baseline gap-2' : ''}>
          <Text className="text-[20px] font-bold leading-6 text-ink" numberOfLines={1}>
            {value}
          </Text>
          <Text
            className={`text-[10px] leading-3 text-subtle ${wide ? 'min-w-0 flex-1' : ''}`}
            numberOfLines={1}
          >
            {hint}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-1" style={{ minWidth: 140 }}>
      <Text className="text-xs font-semibold uppercase tracking-wider text-muted" numberOfLines={1}>
        {label}
      </Text>
      <Text className="text-[28px] font-bold leading-8 text-ink">{value}</Text>
      <Text className="text-xs text-subtle">{hint}</Text>
    </View>
  );
}

function TargetBar({ gpa, target }: { gpa: number | null; target: number }) {
  const [scaleId] = useGradeScale();
  const ratio = gpa === null ? 0 : Math.max(0, Math.min(1, gpa / 4));
  const targetRatio = Math.max(0, Math.min(1, target / GRADE_SCALES[scaleId].max));
  const onTrack = gpa !== null && gpa >= target;

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium text-muted">Progress to target</Text>
        <Text className={`text-xs font-semibold ${onTrack ? 'text-pine' : 'text-amber'}`}>
          {gpa === null
            ? `Target ${target.toFixed(2)}`
            : onTrack
              ? `On track — ${gpa.toFixed(2)} of ${target.toFixed(2)}`
              : `${(target - gpa).toFixed(2)} below target`}
        </Text>
      </View>

      <View className="h-2.5 w-full overflow-hidden rounded-full bg-line">
        <View
          className={`h-full rounded-full ${onTrack ? 'bg-pine' : 'bg-accent'}`}
          style={{ width: `${ratio * 100}%` }}
        />
        {/* Target marker sits on top of the fill so both stay readable. */}
        <View
          className="absolute top-0 h-full w-0.5 bg-ink/60"
          style={{ left: `${targetRatio * 100}%` }}
        />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Semester card
 * ------------------------------------------------------------------ */

function SemesterCard({
  semester,
  subjects,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  onMakeCurrent,
  onMove,
  onCredits,
  onGrade,
  allSemesters,
  onMoveSubject,
}: {
  semester: Semester;
  subjects: Subject[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMakeCurrent: () => void;
  onMove: (direction: -1 | 1) => void;
  onCredits: (subjectId: string, credits: number) => void;
  onGrade: (subjectId: string, grade: string | null) => void;
  allSemesters: Semester[];
  onMoveSubject: (subjectId: string, semester: Semester | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { gpa, credits, graded } = calculateGpa(subjects);

  return (
    <Card className={`gap-4 ${semester.isCurrent ? 'border-accent/40 bg-accent-soft/25' : ''}`}>
      <View className="flex-row flex-wrap items-start justify-between gap-3">
        <View className="flex-1 gap-1.5" style={{ minWidth: 200 }}>
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="text-[17px] font-bold text-ink">{semester.name}</Text>
            {semester.isCurrent ? <Badge label="Current" tone="accent" /> : null}
          </View>
          <Text className="text-xs text-muted">
            {[
              `${semester.term} ${semester.year}`,
              semester.startDate && semester.endDate
                ? `${dateFieldValue(semester.startDate)} to ${dateFieldValue(semester.endDate)}`
                : null,
              semester.teachingWeeks ? `${semester.teachingWeeks} weeks` : null,
              `${subjects.length} ${subjects.length === 1 ? 'subject' : 'subjects'}`,
              `${credits} credits`,
              gpa === null ? null : `GPA ${gpa.toFixed(2)}`,
              semester.gpaTarget ? `Target ${semester.gpaTarget.toFixed(2)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>

        <View className="flex-row items-center">
          <IconButton
            icon="chevron-up"
            label={`Move ${semester.name} earlier`}
            onPress={() => canMoveUp && onMove(-1)}
          />
          <IconButton
            icon="chevron-down"
            label={`Move ${semester.name} later`}
            onPress={() => canMoveDown && onMove(1)}
          />
          {!semester.isCurrent ? (
            <IconButton icon="star" label={`Make ${semester.name} current`} onPress={onMakeCurrent} />
          ) : null}
          <IconButton icon="edit-2" label={`Edit ${semester.name}`} onPress={onEdit} />
          <IconButton
            icon={confirming ? 'check' : 'trash-2'}
            tone="rose"
            label={confirming ? `Confirm deleting ${semester.name}` : `Delete ${semester.name}`}
            onPress={() => {
              if (confirming) onDelete();
              else setConfirming(true);
            }}
          />
        </View>
      </View>

      {confirming ? (
        <Notice
          tone="amber"
          title="Press the tick to confirm"
          body={`Deleting "${semester.name}" keeps its ${subjects.length} subject${
            subjects.length === 1 ? '' : 's'
          } and all uploaded material — they simply become unassigned.`}
        />
      ) : null}

      {subjects.length === 0 ? (
        <View className="rounded-xl border border-dashed border-line px-4 py-6">
          <Text className="text-center text-sm text-muted">
            No subjects yet. Assign them from the shelf below.
          </Text>
        </View>
      ) : (
        <View className="gap-2">
          {subjects.map((subject) => (
            <SubjectRow
              key={subject.id}
              subject={subject}
              onCredits={(credits) => onCredits(subject.id, credits)}
              onGrade={(grade) => onGrade(subject.id, grade)}
              semesters={allSemesters}
              currentSemesterId={semester.id}
              onMove={(target) => onMoveSubject(subject.id, target)}
            />
          ))}
        </View>
      )}

      {graded > 0 && graded < credits ? (
        <Text className="text-xs text-subtle">
          GPA is based on {graded} graded of {credits} credits.
        </Text>
      ) : null}
    </Card>
  );
}

function SubjectRow({
  subject,
  onCredits,
  onGrade,
  semesters,
  currentSemesterId,
  onMove,
}: {
  subject: Subject;
  onCredits: (credits: number) => void;
  onGrade: (grade: string | null) => void;
  semesters: Semester[];
  currentSemesterId: string;
  onMove: (semester: Semester | null) => void;
}) {
  const [gradeOpen, setGradeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const credits = subject.creditHours ?? 0;

  return (
    <View className="gap-2 rounded-xl border border-line bg-surface p-3">
      <View className="flex-row flex-wrap items-center gap-3">
        <View
          className="h-7 w-7 items-center justify-center rounded-lg"
          style={{ backgroundColor: subjectTint(subject.color, 0.12) }}
        >
          <Icon name="book" size={13} color={subjectInk(subject.color)} />
        </View>

        <Link href={`/knowledge/subject/${subject.id}`} asChild>
          <Pressable className="flex-1" style={{ minWidth: 120 }}>
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {subject.name}
            </Text>
            {subject.moduleCode ? (
              <Text className="text-xs text-subtle">{subject.moduleCode}</Text>
            ) : null}
          </Pressable>
        </Link>

        {/* Credit hours are a small integer; steppers beat a keyboard here. */}
        <View className="flex-row items-center gap-1 rounded-lg bg-sand px-1 py-0.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decrease credit hours for ${subject.name}`}
            onPress={() => onCredits(credits - 1)}
            className="h-6 w-6 items-center justify-center"
          >
            <Icon name="minus" size={12} tone="muted" />
          </Pressable>
          <Text className="min-w-[46px] text-center text-xs font-semibold text-ink">
            {credits} cr
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Increase credit hours for ${subject.name}`}
            onPress={() => onCredits(credits + 1)}
            className="h-6 w-6 items-center justify-center"
          >
            <Icon name="plus" size={12} tone="muted" />
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Set grade for ${subject.name}`}
          onPress={() => setGradeOpen((open) => !open)}
          className={`min-w-[64px] flex-row items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 ${
            subject.grade ? 'bg-pine-soft' : 'bg-sand'
          }`}
        >
          <Text
            className={`text-xs font-bold ${subject.grade ? 'text-pine' : 'text-muted'}`}
          >
            {subject.grade ?? 'Grade'}
          </Text>
          <Icon name="chevron-down" size={11} tone={subject.grade ? 'pine' : 'muted'} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${subject.name} to another term`}
          accessibilityState={{ expanded: moveOpen }}
          onPress={() => {
            setGradeOpen(false);
            setMoveOpen((open) => !open);
          }}
          className={`flex-row items-center gap-1.5 rounded-lg px-2.5 py-1.5 ${
            moveOpen ? 'bg-ink' : 'bg-sand'
          }`}
        >
          <Icon name="layers" size={12} tone={moveOpen ? 'inverse' : 'muted'} />
          <Text className={`text-xs font-semibold ${moveOpen ? 'text-paper' : 'text-muted'}`}>
            Move
          </Text>
          <Icon name="chevron-down" size={11} tone={moveOpen ? 'inverse' : 'muted'} />
        </Pressable>
      </View>

      {gradeOpen ? (
        <View className="flex-row flex-wrap gap-1.5 border-t border-line pt-2.5">
          {GRADE_OPTIONS.map((grade) => (
            <Pressable
              key={grade}
              accessibilityRole="button"
              onPress={() => {
                onGrade(grade);
                setGradeOpen(false);
              }}
              className={`rounded-lg px-2.5 py-1.5 ${
                subject.grade === grade ? 'bg-ink' : 'bg-sand'
              }`}
            >
              <Text
                className={`text-xs font-semibold ${
                  subject.grade === grade ? 'text-paper' : 'text-ink'
                }`}
              >
                {grade}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onGrade(null);
              setGradeOpen(false);
            }}
            className="rounded-lg px-2.5 py-1.5"
          >
            <Text className="text-xs font-semibold text-muted">Clear</Text>
          </Pressable>
        </View>
      ) : null}

      {moveOpen ? (
        <View className="gap-2 border-t border-line pt-2.5">
          <Text className="text-xs font-medium text-muted">
            Move the subject and all of its timetable sessions to:
          </Text>
          <View className="flex-row flex-wrap gap-1.5">
            {semesters
              .filter((semester) => semester.id !== currentSemesterId)
              .map((semester) => (
                <Pressable
                  key={semester.id}
                  accessibilityRole="button"
                  onPress={() => {
                    onMove(semester);
                    setMoveOpen(false);
                  }}
                  className="rounded-lg bg-sand px-3 py-2"
                >
                  <Text className="text-xs font-semibold text-ink">{semester.name}</Text>
                </Pressable>
              ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onMove(null);
                setMoveOpen(false);
              }}
              className="rounded-lg border border-line bg-surface px-3 py-2"
            >
              <Text className="text-xs font-semibold text-muted">Leave unassigned</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * Unassigned subjects
 * ------------------------------------------------------------------ */

function UnassignedShelf({
  subjects,
  semesters,
  onAssign,
}: {
  subjects: Subject[];
  semesters: Semester[];
  onAssign: (subjectId: string, semester: Semester) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card className="gap-3">
      <View className="gap-1">
        <Text className="text-[15px] font-semibold text-ink">Unassigned subjects</Text>
        <Text className="text-xs text-muted">
          Subjects created by uploads land here until you file them into a semester.
        </Text>
      </View>

      <View className="gap-2">
        {subjects.map((subject) => (
          <View key={subject.id} className="gap-2 rounded-xl border border-line p-3">
            <View className="flex-row items-center gap-3">
              <View
                className="h-7 w-7 items-center justify-center rounded-lg"
                style={{ backgroundColor: subjectTint(subject.color, 0.12) }}
              >
                <Icon name="book" size={13} color={subjectInk(subject.color)} />
              </View>
              <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
                {subject.name}
              </Text>
              <Button
                label={open === subject.id ? 'Cancel' : 'Assign'}
                variant={open === subject.id ? 'ghost' : 'secondary'}
                size="sm"
                onPress={() => setOpen(open === subject.id ? null : subject.id)}
              />
            </View>

            {open === subject.id ? (
              <View className="flex-row flex-wrap gap-1.5 border-t border-line pt-2.5">
                {semesters.map((semester) => (
                  <Pressable
                    key={semester.id}
                    accessibilityRole="button"
                    onPress={() => {
                      onAssign(subject.id, semester);
                      setOpen(null);
                    }}
                    className="rounded-lg bg-sand px-3 py-1.5"
                  >
                    <Text className="text-xs font-semibold text-ink">{semester.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Add / edit modal
 * ------------------------------------------------------------------ */

function SemesterModal({
  semester,
  existingCount,
  usedTerms,
  onSave,
  onClose,
}: {
  semester: Semester | 'new' | null;
  existingCount: number;
  usedTerms: string[];
  onSave: (input: SemesterInput) => void;
  onClose: () => void;
}) {
  if (semester === null) return null;
  const isNew = semester === 'new';

  // Remounting on every open is what keeps the fields in step with whichever
  // term was clicked, without an effect that syncs props into state.
  return (
    <SemesterForm
      key={isNew ? 'new' : semester.id}
      record={isNew ? null : semester}
      existingCount={existingCount}
      usedTerms={usedTerms}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

function SemesterForm({
  record,
  existingCount,
  usedTerms,
  onSave,
  onClose,
}: {
  record: Semester | null;
  existingCount: number;
  /** Terms this student already uses, offered ahead of the generic defaults. */
  usedTerms: string[];
  onSave: (input: SemesterInput) => void;
  onClose: () => void;
}) {
  const thisYear = new Date().getFullYear();
  const [scaleId] = useGradeScale();
  const gradeCeiling = GRADE_SCALES[scaleId].max;
  const [name, setName] = useState(record?.name ?? `Term ${existingCount + 1}`);
  const [year, setYear] = useState(String(record?.year ?? thisYear));
  const [term, setTerm] = useState<string>(record?.term ?? usedTerms[0] ?? '');
  const [target, setTarget] = useState(record?.gpaTarget ? String(record.gpaTarget) : '');
  const [startDate, setStartDate] = useState(() => dateFieldValue(record?.startDate));
  const [endDate, setEndDate] = useState(() => dateFieldValue(record?.endDate));
  const [weeks, setWeeks] = useState(String(record?.teachingWeeks ?? 14));

  const termOptions = useMemo(() => {
    const seen = new Set(usedTerms.map((value) => value.toLowerCase()));
    return [...usedTerms, ...TERM_SUGGESTIONS.filter((value) => !seen.has(value.toLowerCase()))];
  }, [usedTerms]);

  const parsedYear = Number.parseInt(year, 10);
  const parsedTarget = target.trim() ? Number.parseFloat(target) : null;
  const targetInvalid =
    parsedTarget !== null &&
    (Number.isNaN(parsedTarget) || parsedTarget <= 0 || parsedTarget > gradeCeiling);
  const parsedStart = parseDateField(startDate);
  const parsedEnd = parseDateField(endDate, true);
  const parsedWeeks = Number.parseInt(weeks, 10);
  const datesInvalid = (!!startDate && !parsedStart) || (!!endDate && !parsedEnd) || (!!parsedStart && !!parsedEnd && parsedEnd <= parsedStart);
  const weeksInvalid = !Number.isFinite(parsedWeeks) || parsedWeeks < 1 || parsedWeeks > 60;
  const valid =
    name.trim().length > 0 && term.trim().length > 0 && Number.isFinite(parsedYear) && !targetInvalid && !datesInvalid && !weeksInvalid;

  return (
    <Sheet
      visible
      onClose={onClose}
      title={record ? 'Edit term' : 'New term'}
      icon="layers"
      footer={
        <>
          <View className="flex-1" />
          <Button label="Cancel" variant="ghost" size="sm" onPress={onClose} />
          <Button
            label={record ? 'Save' : 'Add term'}
            size="sm"
            disabled={!valid}
            onPress={() =>
              onSave({
                name: name.trim(),
                year: parsedYear,
                term: term.trim(),
                gpaTarget: parsedTarget,
                startDate: parsedStart,
                endDate: parsedEnd,
                teachingWeeks: parsedWeeks,
              })
            }
          />
        </>
      }
    >
      <Field label="Name" value={name} onChangeText={setName} placeholder="Year 2 · Semester 1" />

        {/* Free text, not a fixed list: a student on trimesters or clinical
            phases should not have to pretend they are on semesters. The chips
            are shortcuts — whatever they have used before, then defaults. */}
        <Field
          label="Term"
          value={term}
          onChangeText={setTerm}
          placeholder="Trimester 1 · Pre-Med Phase A · Year 2 Fall"
        />
        <View className="flex-row flex-wrap gap-1.5">
          {termOptions.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="button"
              accessibilityState={{ selected: term === option }}
              onPress={() => setTerm(option)}
              className={`rounded-lg px-3 py-1.5 ${term === option ? 'bg-ink' : 'bg-sand'}`}
            >
              <Text
                className={`text-xs font-semibold ${term === option ? 'text-paper' : 'text-muted'}`}
              >
                {option}
              </Text>
            </Pressable>
          ))}
        </View>

        <Field
          label="Year"
          value={year}
          onChangeText={setYear}
          keyboardType="number-pad"
          placeholder={String(thisYear)}
        />

        <View className="flex-row flex-wrap gap-3">
          <View className="min-w-[180px] flex-1">
            <Field
              label="Start date"
              value={startDate}
              onChangeText={setStartDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
            />
          </View>
          <View className="min-w-[180px] flex-1">
            <Field
              label="End date"
              value={endDate}
              onChangeText={setEndDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              hint={datesInvalid ? 'Use valid dates, with the end after the start.' : undefined}
            />
          </View>
        </View>

        <Field
          label="Total teaching weeks"
          value={weeks}
          onChangeText={setWeeks}
          keyboardType="number-pad"
          placeholder="14"
          hint={weeksInvalid ? 'Enter between 1 and 60 weeks.' : 'Used for workload and attendance planning.'}
        />

        <Field
          label="GPA target (optional)"
          value={target}
          onChangeText={setTarget}
          keyboardType="decimal-pad"
          placeholder="3.50"
          hint={
            targetInvalid
              ? `Enter a target between 0 and ${gradeCeiling}.`
              : 'Shown as a progress bar against your cumulative GPA.'
          }
        />
    </Sheet>
  );
}

function ViewChip({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-lg px-3 py-2 ${active ? 'bg-ink' : 'bg-sand'}`}
    >
      <Icon name={icon} size={13} tone={active ? 'inverse' : 'muted'} />
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function dateFieldValue(value: Semester['startDate'] | Semester['endDate']): string {
  const date = value?.toDate?.();
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateField(value: string, endOfDay = false): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return value.trim() ? null : null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) return null;
  date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, 0);
  return date;
}
