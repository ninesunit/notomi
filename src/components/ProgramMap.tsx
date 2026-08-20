import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Icon } from '@/components/Icon';
import { Sheet } from './Sheet';
import { Badge, Button, Field } from './ui';
import {
  calculateGpa,
  DAY_LABELS,
  GRADE_OPTIONS,
  GRADE_POINTS,
  minutesToLabel,
  type ClassBlock,
  type Semester,
  type Subject, DEFAULT_SUBJECT_ICON } from '@/lib/schema';
import { requiredAverage } from '@/services/program';
import {
  describeLastStudied,
  formatMinutes,
  type SubjectStudy,
} from '@/services/sessions';

/**
 * The degree as a tree: programme at the root, terms as branches, subjects as
 * leaves.
 *
 * Drawn with nested rows and connector rules rather than an SVG graph. A real
 * force-directed layout looks impressive in a screenshot and is unreadable on a
 * phone; an indented tree with visible edges shows the same structure, stays
 * legible at 390px, and can be operated with a thumb.
 */

export function ProgramMap({
  semesters,
  subjects,
  classes = [],
  study,
  programName = 'My degree',
  /** Compact mode drops the detail drawer and shows only the current term. */
  compact = false,
}: {
  semesters: Semester[];
  subjects: Subject[];
  classes?: ClassBlock[];
  /** Logged study time per subject id, for the detail drawer. */
  study?: Map<string, SubjectStudy>;
  programName?: string;
  compact?: boolean;
}) {
  const current = semesters.find((semester) => semester.isCurrent) ?? semesters[0] ?? null;

  const [open, setOpen] = useState<Set<string>>(
    () => new Set(current ? [current.id] : semesters.slice(0, 1).map((s) => s.id))
  );
  const [selected, setSelected] = useState<Subject | null>(null);

  const visible = compact && current ? [current] : semesters;
  const overall = useMemo(() => calculateGpa(subjects), [subjects]);

  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (semesters.length === 0) {
    return (
      <View className="items-start gap-2 rounded-2xl border border-dashed border-line p-5">
        <Text className="text-sm font-semibold text-ink">No terms yet</Text>
        <Text className="text-[13px] leading-5 text-muted">
          Add a term in the planner, or import a schedule screenshot — your degree map builds
          itself from there.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      {/* Root */}
      <View className="flex-row items-center gap-3 rounded-2xl border border-line bg-ink px-4 py-3.5">
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-paper/15">
          <Icon name="award" size={16} tone="inverse" />
        </View>
        <View className="flex-1">
          <Text className="text-[15px] font-bold text-paper" numberOfLines={1}>
            {programName}
          </Text>
          <Text className="text-[11px] text-paper/60">
            {semesters.length} term{semesters.length === 1 ? '' : 's'} · {overall.credits} credits
            {overall.gpa !== null ? ` · GPA ${overall.gpa.toFixed(2)}` : ''}
          </Text>
        </View>
      </View>

      {visible.map((semester, index) => {
        const termSubjects = subjects.filter((subject) => subject.semesterId === semester.id);
        const stats = calculateGpa(termSubjects);
        const expanded = open.has(semester.id);
        const last = index === visible.length - 1;

        return (
          <View key={semester.id} className="flex-row">
            {/* The connector: a vertical rule with a stub into each node. */}
            <View className="w-6 items-center">
              <View className={`w-px bg-line ${last && !expanded ? 'h-6' : 'flex-1'}`} />
            </View>

            <View className="flex-1 gap-2 pb-1">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${semester.name}, ${termSubjects.length} subjects`}
                onPress={() => toggle(semester.id)}
                className={`flex-row items-center gap-3 rounded-2xl border px-4 py-3 ${
                  semester.isCurrent
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-line bg-surface'
                }`}
              >
                <Icon
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={15}
                  tone="muted"
                />
                <View className="flex-1">
                  <View className="flex-row flex-wrap items-center gap-2">
                    <Text className="text-sm font-bold text-ink">{semester.name}</Text>
                    {semester.isCurrent ? <Badge label="Current" tone="accent" /> : null}
                  </View>
                  <Text className="text-[11px] text-muted">
                    {[
                      `${semester.term} ${semester.year}`,
                      `${termSubjects.length} subject${termSubjects.length === 1 ? '' : 's'}`,
                      `${stats.credits} cr`,
                      stats.gpa !== null ? `GPA ${stats.gpa.toFixed(2)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Text className="text-[11px] font-semibold text-subtle">
                  {termSubjects.length}
                </Text>
              </Pressable>

              {expanded ? (
                <View className="gap-1.5 pl-4">
                  {termSubjects.length === 0 ? (
                    <Text className="py-2 text-xs text-subtle">
                      No subjects filed under this term yet.
                    </Text>
                  ) : (
                    termSubjects.map((subject) => (
                      <Pressable
                        key={subject.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${subject.name} details`}
                        onPress={() => !compact && setSelected(subject)}
                        className="flex-row items-center gap-2.5 rounded-xl border border-line bg-paper px-3 py-2.5"
                        style={{ borderLeftWidth: 3, borderLeftColor: subject.color }}
                      >
                        <Icon name={(subject.icon ?? DEFAULT_SUBJECT_ICON) as never} size={15} color={subject.color} />
                        <View className="flex-1">
                          <Text className="text-[13px] font-semibold text-ink" numberOfLines={1}>
                            {subject.name}
                          </Text>
                          <Text className="text-[11px] text-subtle" numberOfLines={1}>
                            {[
                              subject.moduleCode,
                              subject.creditHours ? `${subject.creditHours} cr` : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || 'No code'}
                          </Text>
                        </View>
                        {subject.grade ? (
                          <View className="rounded-full bg-pine-soft px-2 py-0.5">
                            <Text className="text-[11px] font-bold text-pine">{subject.grade}</Text>
                          </View>
                        ) : (
                          <Icon name="circle" size={12} tone="line" />
                        )}
                      </Pressable>
                    ))
                  )}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}

      {!compact ? <GpaSimulator subjects={subjects} /> : null}

      {selected ? (
        <SubjectDrawer
          subject={selected}
          classes={classes.filter((block) => block.subjectId === selected.id)}
          study={study?.get(selected.id) ?? null}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}

/**
 * Detail drawer for a subject leaf: what it is, where it meets, how it is
 * going, and a way into its material.
 */
function SubjectDrawer({
  subject,
  classes,
  study,
  onClose,
}: {
  subject: Subject;
  classes: ClassBlock[];
  study: SubjectStudy | null;
  onClose: () => void;
}) {
  const points = subject.grade ? GRADE_POINTS[subject.grade] : null;

  return (
    <Sheet
      visible
      onClose={onClose}
      title={subject.name}
      footer={
        <>
          <View className="flex-1" />
          <Link href={`/knowledge/subject/${subject.id}`} asChild>
            <Button label="Jump to library folder" icon="folder" size="sm" onPress={onClose} />
          </Link>
        </>
      }
    >
      <View
        className="flex-row items-center gap-3 rounded-xl p-4"
        style={{ backgroundColor: `${subject.color}14` }}
      >
        <Icon name={(subject.icon ?? DEFAULT_SUBJECT_ICON) as never} size={22} color={subject.color} />
        <View className="flex-1">
          <Text className="text-[15px] font-bold text-ink">{subject.name}</Text>
          <Text className="text-xs text-muted">
            {[subject.moduleCode, subject.tag].filter(Boolean).join(' · ') || 'No module code'}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-3">
        <Stat label="Credits" value={String(subject.creditHours ?? 0)} />
        <Stat label="Grade" value={subject.grade ?? '—'} />
        <Stat
          label="Grade points"
          value={points === null || points === undefined ? '—' : points.toFixed(1)}
        />
        <Stat label="Sources" value={String(subject.documentCount ?? 0)} />
        <Stat label="Studied" value={formatMinutes(study?.minutes ?? 0)} />
        <Stat label="This week" value={formatMinutes(study?.minutesThisWeek ?? 0)} />
      </View>

      <Text className="text-xs text-subtle">
        {describeLastStudied(study?.lastStudied ?? null)}
        {study?.sessions ? ` · ${study.sessions} session${study.sessions === 1 ? '' : 's'}` : ''}
      </Text>

      <View className="gap-2">
        <Text className="text-sm font-medium text-muted">Class times</Text>
        {classes.length === 0 ? (
          <Text className="text-[13px] text-subtle">
            No classes on the timetable for this subject yet.
          </Text>
        ) : (
          classes
            .slice()
            .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute)
            .map((block) => (
              <View
                key={block.id}
                className="flex-row items-center gap-3 rounded-xl border border-line p-3"
              >
                <Text className="w-9 text-xs font-bold text-ink">{DAY_LABELS[block.day]}</Text>
                <Text className="flex-1 text-[13px] text-ink" numberOfLines={1}>
                  {minutesToLabel(block.startMinute)}–{minutesToLabel(block.endMinute)}
                  {block.kind ? ` · ${block.kind}` : ''}
                </Text>
                <Text className="text-xs text-subtle" numberOfLines={1}>
                  {block.venue ?? '—'}
                </Text>
              </View>
            ))
        )}
      </View>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View
      className="flex-1 grow gap-1 rounded-xl bg-sand p-3"
      style={{ minWidth: 90, flexBasis: 90 }}
    >
      <Text className="text-lg font-bold text-ink">{value}</Text>
      <Text className="text-[11px] text-muted">{label}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * GPA target simulator
 * ------------------------------------------------------------------ */

/**
 * What-if grades, in place on the map.
 *
 * Every subject without a recorded grade gets a hypothetical one, and the
 * projection updates as they change. Nothing is written: the point is to answer
 * "what do I need in the courses I am still taking", which is a question you
 * ask repeatedly and never want to save the answer to.
 */
function GpaSimulator({ subjects }: { subjects: Subject[] }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('3.50');
  const [hypothetical, setHypothetical] = useState<Record<string, string>>({});

  const graded = subjects.filter((subject) => subject.grade && (subject.creditHours ?? 0) > 0);
  const ungraded = subjects.filter((subject) => !subject.grade && (subject.creditHours ?? 0) > 0);

  const projected = useMemo(
    () =>
      calculateGpa(
        subjects.map((subject) => ({
          creditHours: subject.creditHours,
          grade: subject.grade ?? hypothetical[subject.id] ?? null,
        }))
      ),
    [subjects, hypothetical]
  );

  const actual = useMemo(() => calculateGpa(subjects), [subjects]);

  // What the remaining credits have to average for the target to be reachable.
  const parsedTarget = Number.parseFloat(target);
  const remainingCredits = ungraded.reduce(
    (total, subject) => total + (subject.creditHours ?? 0),
    0
  );
  const earnedPoints = actual.gpa === null ? 0 : actual.gpa * actual.graded;
  const needed = Number.isFinite(parsedTarget)
    ? requiredAverage(parsedTarget, earnedPoints, actual.graded, remainingCredits)
    : null;

  if (subjects.length === 0) return null;

  return (
    <View className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-3 px-4 py-3.5"
      >
        <Icon name="target" size={18} tone="accent" />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-ink">GPA target simulator</Text>
          <Text className="text-[11px] text-muted">
            {ungraded.length === 0
              ? 'Every subject is graded — nothing left to project.'
              : `Try grades for your ${ungraded.length} ungraded subject${
                  ungraded.length === 1 ? '' : 's'
                }`}
          </Text>
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} tone="muted" />
      </Pressable>

      {open ? (
        <View className="gap-4 border-t border-line p-4">
          <View className="flex-row flex-wrap gap-4">
            <View className="gap-1" style={{ minWidth: 120 }}>
              <Text className="text-[11px] font-bold uppercase tracking-wider text-muted">
                Projected
              </Text>
              <Text className="text-[28px] font-bold leading-8 text-ink">
                {projected.gpa === null ? '—' : projected.gpa.toFixed(2)}
              </Text>
              <Text className="text-[11px] text-subtle">
                now {actual.gpa === null ? '—' : actual.gpa.toFixed(2)}
              </Text>
            </View>

            <View className="flex-1 gap-1.5" style={{ minWidth: 180 }}>
              <Field
                label="Target GPA"
                value={target}
                onChangeText={setTarget}
                keyboardType="decimal-pad"
                placeholder="3.50"
              />
              {needed !== null ? (
                <Text className={`text-xs font-medium ${needed > 4 ? 'text-rose' : 'text-pine'}`}>
                  {needed > 4
                    ? `Out of reach — you would need a ${needed.toFixed(2)} average across ${remainingCredits} remaining credits.`
                    : `Average ${needed.toFixed(2)} across your ${remainingCredits} ungraded credits.`}
                </Text>
              ) : remainingCredits === 0 ? (
                <Text className="text-xs text-subtle">
                  No ungraded credits left to project against.
                </Text>
              ) : null}
            </View>
          </View>

          {ungraded.length > 0 ? (
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-medium text-muted">Hypothetical grades</Text>
                {Object.keys(hypothetical).length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setHypothetical({})}
                    hitSlop={6}
                  >
                    <Text className="text-xs font-semibold text-accent">Clear</Text>
                  </Pressable>
                ) : null}
              </View>

              {ungraded.map((subject) => (
                <View key={subject.id} className="gap-1.5 rounded-xl border border-line p-3">
                  <Text className="text-[13px] font-semibold text-ink" numberOfLines={1}>
                    {subject.name}
                    <Text className="text-[11px] font-normal text-subtle">
                      {'  '}
                      {subject.creditHours ?? 0} cr
                    </Text>
                  </Text>

                  <View className="flex-row flex-wrap gap-1">
                    {GRADE_OPTIONS.map((grade) => {
                      const active = hypothetical[subject.id] === grade;
                      return (
                        <Pressable
                          key={grade}
                          accessibilityRole="button"
                          accessibilityLabel={`Assume ${grade} for ${subject.name}`}
                          accessibilityState={{ selected: active }}
                          onPress={() =>
                            setHypothetical((previous) => {
                              const next = { ...previous };
                              if (active) delete next[subject.id];
                              else next[subject.id] = grade;
                              return next;
                            })
                          }
                          className={`rounded-md px-2 py-1 ${active ? 'bg-ink' : 'bg-sand'}`}
                        >
                          <Text
                            className={`text-[11px] font-bold ${
                              active ? 'text-paper' : 'text-muted'
                            }`}
                          >
                            {grade}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <Text className="text-[11px] leading-4 text-subtle">
            Nothing here is saved. {graded.length} graded subject
            {graded.length === 1 ? ' anchors' : 's anchor'} the projection; record a real grade in
            the planner when you get it.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
