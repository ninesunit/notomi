import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { Semester, Subject } from '@/lib/schema';

/**
 * Scopes a list of subjects to one term.
 *
 * A degree accumulates: by year three a student has thirty subject folders and
 * only five of them are live. The filter defaults to the current term for that
 * reason — "what am I taking now" is the common case, and browsing what you
 * took last year is the deliberate one.
 */

/** 'all', 'unassigned', or a semester id. */
export type TermScope = string;

export function filterByTerm(
  subjects: Subject[],
  scope: TermScope,
  semesters: Semester[]
): Subject[] {
  if (scope === 'all') return subjects;

  if (scope === 'unassigned') {
    const live = new Set(semesters.map((semester) => semester.id));
    // A subject pointing at a deleted term is unassigned in every way that
    // matters, so it shows here rather than vanishing from every filter.
    return subjects.filter(
      (subject) => !subject.semesterId || !live.has(subject.semesterId)
    );
  }

  return subjects.filter((subject) => subject.semesterId === scope);
}

/** The scope to open on: the current term if it has subjects, else everything. */
export function defaultScope(subjects: Subject[], semesters: Semester[]): TermScope {
  const current = semesters.find((semester) => semester.isCurrent);
  if (!current) return 'all';
  const hasSubjects = subjects.some((subject) => subject.semesterId === current.id);
  return hasSubjects ? current.id : 'all';
}

export function TermFilter({
  semesters,
  subjects,
  scope,
  onScope,
}: {
  semesters: Semester[];
  subjects: Subject[];
  scope: TermScope;
  onScope: (scope: TermScope) => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const subject of subjects) {
      if (!subject.semesterId) continue;
      map.set(subject.semesterId, (map.get(subject.semesterId) ?? 0) + 1);
    }
    return map;
  }, [subjects]);

  const unassigned = useMemo(
    () => filterByTerm(subjects, 'unassigned', semesters).length,
    [subjects, semesters]
  );

  // Nothing to scope by: one term and no strays is just "all".
  if (semesters.length === 0 && unassigned === subjects.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-5">
      <View className="flex-row gap-1.5 pr-4">
        <Chip
          label="All"
          count={subjects.length}
          active={scope === 'all'}
          onPress={() => onScope('all')}
        />

        {semesters.map((semester) => (
          <Chip
            key={semester.id}
            label={semester.name}
            count={counts.get(semester.id) ?? 0}
            current={semester.isCurrent}
            active={scope === semester.id}
            onPress={() => onScope(semester.id)}
          />
        ))}

        {unassigned > 0 ? (
          <Chip
            label="Unfiled"
            count={unassigned}
            active={scope === 'unassigned'}
            onPress={() => onScope('unassigned')}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

function Chip({
  label,
  count,
  active,
  current = false,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  current?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} subjects`}
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-full border px-3.5 py-2 ${
        active ? 'border-ink bg-ink' : 'border-line bg-surface'
      }`}
    >
      {current ? (
        <View
          className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-accent' : 'bg-accent'}`}
        />
      ) : null}
      <Text
        className={`text-[13px] font-semibold ${active ? 'text-paper' : 'text-muted'}`}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text className={`text-[11px] ${active ? 'text-paper/60' : 'text-subtle'}`}>{count}</Text>
    </Pressable>
  );
}
