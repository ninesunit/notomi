import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { orderBy, query } from 'firebase/firestore';
import { ScreenScroll } from '@/components/ScreenScroll';
import { ResponsiveTermPicker } from '@/components/ResponsiveTermPicker';
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { getDb } from '@/services/firebase';
import { paths } from '@/lib/paths';
import {
  calculateGpa,
  GRADE_OPTIONS,
  GRADE_POINTS,
  type Semester,
  type Subject,
} from '@/lib/schema';
import { requiredAverage, sortSemesters } from '@/services/program';

/**
 * A what-if GPA calculator over the real program.
 *
 * Everything on this screen is scratch: rows start from the student's actual
 * subjects, and changing a grade here shows what *would* happen without
 * touching Firestore. Saving is a deliberate act on the planner screen.
 */

type Row = {
  id: string;
  label: string;
  credits: number;
  grade: string | null;
  /** Rows the student added by hand, rather than real subjects. */
  scratch: boolean;
};

export default function GpaCalculator() {
  const uid = useUid();
  const db = getDb();
  const [scope, setScope] = useState<string>('all');
  const [overrides, setOverrides] = useState<Record<string, Partial<Row>>>({});
  const [extras, setExtras] = useState<Row[]>([]);
  const [target, setTarget] = useState('');

  const semesters = useCollection<Semester>(
    query(paths.semesters(db, uid), orderBy('order', 'asc')),
    [uid]
  );
  const subjects = useCollection<Subject>(
    query(paths.subjects(db, uid), orderBy('name', 'asc')),
    [uid]
  );

  const ordered = useMemo(() => sortSemesters(semesters.data), [semesters.data]);

  const rows = useMemo<Row[]>(() => {
    const inScope =
      scope === 'all'
        ? subjects.data
        : subjects.data.filter((subject) => subject.semesterId === scope);

    const base: Row[] = inScope.map((subject) => ({
      id: subject.id,
      label: subject.name,
      credits: subject.creditHours ?? 0,
      grade: subject.grade ?? null,
      scratch: false,
    }));

    return [...base, ...extras].map((row) => ({ ...row, ...overrides[row.id] }));
  }, [subjects.data, scope, extras, overrides]);

  const result = useMemo(
    () => calculateGpa(rows.map((row) => ({ creditHours: row.credits, grade: row.grade }))),
    [rows]
  );

  // Ungraded credits are what is still up for grabs, which is exactly the
  // denominator the "what do I need" answer is computed over.
  const remaining = result.credits - result.graded;
  const earnedPoints = result.gpa === null ? 0 : result.gpa * result.graded;
  const parsedTarget = target.trim() ? Number.parseFloat(target) : null;
  const needed =
    parsedTarget !== null && Number.isFinite(parsedTarget)
      ? requiredAverage(parsedTarget, earnedPoints, result.graded, remaining)
      : null;

  const patch = (id: string, change: Partial<Row>) =>
    setOverrides((previous) => ({ ...previous, [id]: { ...previous[id], ...change } }));

  const loading = semesters.loading || subjects.loading;

  return (
    <ScreenScroll>
      <Link href="/schedule?tab=terms" asChild>
        <Pressable className="mb-5 flex-row items-center gap-1.5 self-start py-1">
          <Icon name="arrow-left" size={15} tone="muted" />
          <Text className="text-sm font-medium text-muted">Back to Term Management</Text>
        </Pressable>
      </Link>

      <PageHeader
        title="GPA calculator"
        subtitle="Try different grades without changing anything. Nothing here is saved."
        actions={
          Object.keys(overrides).length > 0 || extras.length > 0 ? (
            <Button
              label="Reset"
              icon="rotate-ccw"
              variant="secondary"
              size="sm"
              onPress={() => {
                setOverrides({});
                setExtras([]);
              }}
            />
          ) : undefined
        }
      />

      {subjects.error ? (
        <View className="mb-6">
          <Notice title="Could not load your subjects" body={subjects.error.message} />
        </View>
      ) : null}

      {loading ? (
        <Loading label="Loading your subjects…" />
      ) : (
        <View className="gap-6">
          <Card className="gap-5 bg-sand/60">
            <View className="flex-row flex-wrap gap-x-10 gap-y-5">
              <View className="gap-1" style={{ minWidth: 150 }}>
                <Text className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Projected GPA
                </Text>
                <Text className="text-[34px] font-bold leading-10 text-ink">
                  {result.gpa === null ? '—' : result.gpa.toFixed(2)}
                </Text>
                <Text className="text-xs text-subtle">
                  {result.graded} graded of {result.credits} credits
                </Text>
              </View>

              <View className="flex-1 gap-1.5" style={{ minWidth: 200 }}>
                <Field
                  label="Target GPA"
                  value={target}
                  onChangeText={setTarget}
                  keyboardType="decimal-pad"
                  placeholder="3.50"
                />
                {needed !== null ? (
                  <Text
                    className={`text-xs font-medium ${needed > 4 ? 'text-rose' : 'text-pine'}`}
                  >
                    {needed > 4
                      ? `Out of reach — ${needed.toFixed(2)} average needed across ${remaining} remaining credits.`
                      : `Average ${needed.toFixed(2)} (${closestGrade(needed)}) across your ${remaining} ungraded credits.`}
                  </Text>
                ) : parsedTarget !== null && remaining <= 0 ? (
                  <Text className="text-xs text-subtle">
                    Every credit is graded — add ungraded credits to project forward.
                  </Text>
                ) : null}
              </View>
            </View>
          </Card>

          {ordered.length > 0 ? (
            <ResponsiveTermPicker
              options={[
                { id: 'all', label: 'All semesters' },
                ...ordered.map((semester) => ({
                  id: semester.id,
                  label: semester.name,
                  current: semester.isCurrent,
                })),
              ]}
              value={scope}
              onChange={setScope}
              title="Filter GPA by term"
            />
          ) : null}

          {rows.length === 0 ? (
            <EmptyState
              icon="trending-up"
              title="Nothing to calculate yet"
              body="Upload material to create subjects, give them credit hours in the planner, or add a scratch row below."
              action={
                <Button
                  label="Add a row"
                  icon="plus"
                  onPress={() => setExtras((list) => [...list, blankRow(list.length)])}
                />
              }
            />
          ) : (
            <Card className="gap-2">
              {rows.map((row) => (
                <GpaRow
                  key={row.id}
                  row={row}
                  onCredits={(credits) => patch(row.id, { credits })}
                  onGrade={(grade) => patch(row.id, { grade })}
                  onLabel={(label) => patch(row.id, { label })}
                  onRemove={
                    row.scratch
                      ? () => {
                          setExtras((list) => list.filter((entry) => entry.id !== row.id));
                          setOverrides(({ [row.id]: _removed, ...rest }) => rest);
                        }
                      : undefined
                  }
                />
              ))}

              <Button
                label="Add a row"
                icon="plus"
                variant="ghost"
                size="sm"
                className="self-start"
                onPress={() => setExtras((list) => [...list, blankRow(list.length)])}
              />
            </Card>
          )}

          <Text className="text-xs leading-5 text-subtle">
            Grades use a 4.0 scale. To keep a change, set it on the subject in the program planner —
            that is what feeds your real cumulative GPA.
          </Text>
        </View>
      )}
    </ScreenScroll>
  );
}

function blankRow(index: number): Row {
  return {
    id: `scratch-${Date.now()}-${index}`,
    label: 'New course',
    credits: 3,
    grade: null,
    scratch: true,
  };
}

/** The letter a numeric average lands closest to, for a human-readable answer. */
function closestGrade(points: number): string {
  let best = GRADE_OPTIONS[0];
  let distance = Infinity;
  for (const grade of GRADE_OPTIONS) {
    const gap = Math.abs(GRADE_POINTS[grade] - points);
    if (gap < distance) {
      distance = gap;
      best = grade;
    }
  }
  return `about ${best}`;
}

function GpaRow({
  row,
  onCredits,
  onGrade,
  onLabel,
  onRemove,
}: {
  row: Row;
  onCredits: (credits: number) => void;
  onGrade: (grade: string | null) => void;
  onLabel: (label: string) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View className="gap-2 rounded-xl border border-line p-3">
      <View className="flex-row flex-wrap items-center gap-3">
        {row.scratch ? (
          <View className="flex-1" style={{ minWidth: 140 }}>
            <Field value={row.label} onChangeText={onLabel} className="py-2" />
          </View>
        ) : (
          <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1} style={{ minWidth: 140 }}>
            {row.label}
          </Text>
        )}

        <View className="flex-row items-center gap-1 rounded-lg bg-sand px-1 py-0.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decrease credits for ${row.label}`}
            onPress={() => onCredits(Math.max(0, row.credits - 1))}
            className="h-6 w-6 items-center justify-center"
          >
            <Icon name="minus" size={12} tone="muted" />
          </Pressable>
          <Text className="min-w-[46px] text-center text-xs font-semibold text-ink">
            {row.credits} cr
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Increase credits for ${row.label}`}
            onPress={() => onCredits(Math.min(30, row.credits + 1))}
            className="h-6 w-6 items-center justify-center"
          >
            <Icon name="plus" size={12} tone="muted" />
          </Pressable>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Set grade for ${row.label}`}
          onPress={() => setOpen((value) => !value)}
          className={`min-w-[64px] flex-row items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 ${
            row.grade ? 'bg-pine-soft' : 'bg-sand'
          }`}
        >
          <Text className={`text-xs font-bold ${row.grade ? 'text-pine' : 'text-muted'}`}>
            {row.grade ?? 'Grade'}
          </Text>
          <Icon name="chevron-down" size={11} color={row.grade ? '#2E6F5E' : '#6F6A5F'} />
        </Pressable>

        {onRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${row.label}`}
            onPress={onRemove}
            className="h-8 w-8 items-center justify-center rounded-lg"
          >
            <Icon name="x" size={14} tone="rose" />
          </Pressable>
        ) : (
          <Badge label={row.grade ? 'Recorded' : 'Ungraded'} tone={row.grade ? 'pine' : 'neutral'} />
        )}
      </View>

      {open ? (
        <View className="flex-row flex-wrap gap-1.5 border-t border-line pt-2.5">
          {GRADE_OPTIONS.map((grade) => (
            <Pressable
              key={grade}
              accessibilityRole="button"
              onPress={() => {
                onGrade(grade);
                setOpen(false);
              }}
              className={`rounded-lg px-2.5 py-1.5 ${row.grade === grade ? 'bg-ink' : 'bg-sand'}`}
            >
              <Text
                className={`text-xs font-semibold ${row.grade === grade ? 'text-paper' : 'text-ink'}`}
              >
                {grade}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onGrade(null);
              setOpen(false);
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
