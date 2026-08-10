import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Sheet } from './Sheet';
import { Badge, Button } from './ui';
import {
  calculateGpa,
  DAY_LABELS,
  GRADE_POINTS,
  minutesToLabel,
  type ClassBlock,
  type Semester,
  type Subject,
} from '@/lib/schema';

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
  programName = 'My degree',
  /** Compact mode drops the detail drawer and shows only the current term. */
  compact = false,
}: {
  semesters: Semester[];
  subjects: Subject[];
  classes?: ClassBlock[];
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
          <Feather name="award" size={16} color="#F7F5EE" />
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
                <Feather
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={15}
                  color="#6F6A5F"
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
                        <Text className="text-sm">{subject.emoji ?? '📘'}</Text>
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
                          <Feather name="circle" size={12} color="#C9C4B8" />
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

      {selected ? (
        <SubjectDrawer
          subject={selected}
          classes={classes.filter((block) => block.subjectId === selected.id)}
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
  onClose,
}: {
  subject: Subject;
  classes: ClassBlock[];
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
          <Link href={`/library/${subject.id}`} asChild>
            <Button label="Jump to library folder" icon="folder" size="sm" onPress={onClose} />
          </Link>
        </>
      }
    >
      <View
        className="flex-row items-center gap-3 rounded-xl p-4"
        style={{ backgroundColor: `${subject.color}14` }}
      >
        <Text className="text-2xl">{subject.emoji ?? '📘'}</Text>
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
      </View>

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
