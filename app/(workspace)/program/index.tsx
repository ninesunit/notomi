import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { orderBy, query } from 'firebase/firestore';
import { ProgramMap } from '@/components/ProgramMap';
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

  return (
    <ScreenScroll>
      <PageHeader
        title="Program"
        subtitle={
          ordered.length
            ? `${ordered.length} ${ordered.length === 1 ? 'term' : 'terms'} · ${
                overall.credits
              } credit hours planned`
            : 'Map your degree term by term and track where your GPA is heading.'
        }
        actions={
          <>
            <Link href="/program/gpa" asChild>
              <Button label="GPA calculator" icon="trending-up" variant="secondary" size="sm" />
            </Link>
            <Button label="New term" icon="plus" size="sm" onPress={() => setEditing('new')} />
          </>
        }
      />

      {error ? (
        <View className="mb-6">
          <Notice title="Could not save that change" body={error} />
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
                onUnassign={(subjectId) => void run(assignSubject(uid, subjectId, null))}
              />
            ))
          )}

          {unassigned.length > 0 && view === 'planner' ? (
            <UnassignedShelf
              subjects={unassigned}
              semesters={ordered}
              onAssign={(subjectId, semesterId) =>
                void run(assignSubject(uid, subjectId, semesterId))
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
    </ScreenScroll>
  );
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function OverviewBar({ subjects, semesters }: { subjects: Subject[]; semesters: Semester[] }) {
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
    <Card className="gap-5 bg-sand/60">
      <View className="flex-row flex-wrap gap-x-10 gap-y-5">
        <Stat
          label="Cumulative GPA"
          value={overall.gpa === null ? '—' : overall.gpa.toFixed(2)}
          hint={overall.graded > 0 ? `${overall.graded} graded credits` : 'No grades recorded yet'}
        />
        <Stat label="Credit hours" value={String(overall.credits)} hint="Across all semesters" />
        <Stat
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

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
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
  const ratio = gpa === null ? 0 : Math.max(0, Math.min(1, gpa / 4));
  const targetRatio = Math.max(0, Math.min(1, target / 4));
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
  onUnassign,
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
  onUnassign: (subjectId: string) => void;
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
              onUnassign={() => onUnassign(subject.id)}
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
  onUnassign,
}: {
  subject: Subject;
  onCredits: (credits: number) => void;
  onGrade: (grade: string | null) => void;
  onUnassign: () => void;
}) {
  const [gradeOpen, setGradeOpen] = useState(false);
  const credits = subject.creditHours ?? 0;

  return (
    <View className="gap-2 rounded-xl border border-line bg-surface p-3">
      <View className="flex-row flex-wrap items-center gap-3">
        <View
          className="h-7 w-7 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${subject.color}1F` }}
        >
          <Feather name="book" size={13} color={subject.color} />
        </View>

        <Link href={`/library/${subject.id}`} asChild>
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
            <Feather name="minus" size={12} color="#6F6A5F" />
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
            <Feather name="plus" size={12} color="#6F6A5F" />
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
          <Feather name="chevron-down" size={11} color={subject.grade ? '#2E6F5E' : '#6F6A5F'} />
        </Pressable>

        <IconButton
          icon="x"
          label={`Remove ${subject.name} from this semester`}
          onPress={onUnassign}
        />
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
  onAssign: (subjectId: string, semesterId: string) => void;
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
                style={{ backgroundColor: `${subject.color}1F` }}
              >
                <Feather name="book" size={13} color={subject.color} />
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
                      onAssign(subject.id, semester.id);
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
  const [name, setName] = useState(record?.name ?? `Term ${existingCount + 1}`);
  const [year, setYear] = useState(String(record?.year ?? thisYear));
  const [term, setTerm] = useState<string>(record?.term ?? usedTerms[0] ?? '');
  const [target, setTarget] = useState(record?.gpaTarget ? String(record.gpaTarget) : '');

  const termOptions = useMemo(() => {
    const seen = new Set(usedTerms.map((value) => value.toLowerCase()));
    return [...usedTerms, ...TERM_SUGGESTIONS.filter((value) => !seen.has(value.toLowerCase()))];
  }, [usedTerms]);

  const parsedYear = Number.parseInt(year, 10);
  const parsedTarget = target.trim() ? Number.parseFloat(target) : null;
  const targetInvalid =
    parsedTarget !== null && (Number.isNaN(parsedTarget) || parsedTarget <= 0 || parsedTarget > 4);
  const valid =
    name.trim().length > 0 && term.trim().length > 0 && Number.isFinite(parsedYear) && !targetInvalid;

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

        <Field
          label="GPA target (optional)"
          value={target}
          onChangeText={setTarget}
          keyboardType="decimal-pad"
          placeholder="3.50"
          hint={
            targetInvalid
              ? 'Enter a target between 0 and 4.'
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
  icon: React.ComponentProps<typeof Feather>['name'];
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
      <Feather name={icon} size={13} color={active ? '#F7F5EE' : '#6F6A5F'} />
      <Text className={`text-xs font-semibold ${active ? 'text-paper' : 'text-muted'}`}>
        {label}
      </Text>
    </Pressable>
  );
}
