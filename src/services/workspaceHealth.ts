import { toDate } from '@/lib/dates';
import type { ClassBlock, RoutineBlock, Semester, Subject, Todo } from '@/lib/schema';

export type WorkspaceHealthIssue = {
  id: string;
  title: string;
  body: string;
  href: '/schedule' | '/knowledge' | '/tasks';
};

export function workspaceHealth(input: {
  semesters: Semester[];
  subjects: Subject[];
  classes: ClassBlock[];
  routines: RoutineBlock[];
  todos: Todo[];
}): WorkspaceHealthIssue[] {
  const issues: WorkspaceHealthIssue[] = [];
  const active = input.semesters.find((semester) => semester.isCurrent) ?? input.semesters[0];
  if (active && (!toDate(active.startDate) || !toDate(active.endDate))) {
    issues.push({ id: 'term-dates', title: 'Term dates are incomplete', body: 'Add the term start and end dates.', href: '/schedule' });
  }

  const unassigned = input.subjects.filter((subject) => !subject.semesterId && !subject.isVault);
  if (unassigned.length) {
    issues.push({ id: 'unassigned-subjects', title: `${unassigned.length} subjects need a term`, body: 'Assign them in Term Management.', href: '/schedule' });
  }
  const emptySubjects = input.subjects.filter((subject) => !subject.isVault && (subject.documentCount ?? 0) === 0);
  if (emptySubjects.length) {
    issues.push({ id: 'empty-subjects', title: `${emptySubjects.length} subjects have no material`, body: 'Add slides, notes or a syllabus.', href: '/knowledge' });
  }
  const missingVenues = input.classes.filter((entry) => !entry.venue?.trim());
  if (missingVenues.length) {
    issues.push({ id: 'missing-venues', title: `${missingVenues.length} classes have no venue`, body: 'Add rooms so the dashboard is complete.', href: '/schedule' });
  }

  const blocks = [...input.classes, ...input.routines];
  const overlaps = blocks.some((left, index) => blocks.slice(index + 1).some((right) =>
    left.day === right.day && left.startMinute < right.endMinute && right.startMinute < left.endMinute
  ));
  if (overlaps) {
    issues.push({ id: 'overlap', title: 'Schedule blocks overlap', body: 'Review class and routine times.', href: '/schedule' });
  }
  const undated = input.todos.filter((todo) => !todo.isCompleted && !toDate(todo.dueDate));
  if (undated.length) {
    issues.push({ id: 'undated-tasks', title: `${undated.length} open tasks have no date`, body: 'Add dates so reminders and planning can place them.', href: '/tasks' });
  }

  const codes = new Set<string>();
  const duplicate = input.subjects.some((subject) => {
    const code = subject.moduleCode?.trim().toUpperCase();
    if (!code) return false;
    if (codes.has(code)) return true;
    codes.add(code);
    return false;
  });
  if (duplicate) {
    issues.push({ id: 'duplicate-subject', title: 'A course code appears twice', body: 'Merge or rename the duplicate subject.', href: '/knowledge' });
  }
  return issues;
}
