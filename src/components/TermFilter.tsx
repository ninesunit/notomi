import { useMemo } from 'react';
import { View } from 'react-native';
import { ResponsiveTermPicker, type TermPickerOption } from './ResponsiveTermPicker';
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

  /**
   * Nothing to scope by, so nothing to show.
   *
   * One term with everything filed under it means "All" and that term are the
   * same list, and a filter offering one real choice is a row of chrome the
   * week below it needs the space for.
   */
  if (semesters.length === 0 && unassigned === subjects.length) return null;
  if (semesters.length <= 1 && unassigned === 0) return null;

  const options: TermPickerOption[] = [
    { id: 'all', label: 'All', count: subjects.length },
    ...semesters.map((semester) => ({
      id: semester.id,
      label: semester.name,
      count: counts.get(semester.id) ?? 0,
      current: semester.isCurrent,
    })),
    ...(unassigned > 0 ? [{ id: 'unassigned', label: 'Unfiled', count: unassigned }] : []),
  ];

  return (
    <View className="mb-4">
      <ResponsiveTermPicker
        options={options}
        value={scope}
        onChange={onScope}
        title="Select library term"
      />
    </View>
  );
}
