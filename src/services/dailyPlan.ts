import { toDate } from '@/lib/dates';
import { DAY_FULL, minutesToLabel, todayIndex, type ClassBlock, type RoutineBlock, type Todo } from '@/lib/schema';

export type DailyPlanItem = {
  id: string;
  kind: 'class' | 'routine' | 'task';
  title: string;
  detail: string;
  start: number;
  end: number;
};

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

export function buildDailyPlan(input: {
  classes: ClassBlock[];
  routines: RoutineBlock[];
  todos: Todo[];
  now?: Date;
}): DailyPlanItem[] {
  const now = input.now ?? new Date();
  const day = todayIndex(now);
  const fixed: DailyPlanItem[] = [
    ...input.classes.filter((entry) => entry.day === day).map((entry) => ({
      id: `class-${entry.id}`,
      kind: 'class' as const,
      title: entry.subjectName || entry.title,
      detail: entry.venue?.trim() || 'Venue not set',
      start: entry.startMinute,
      end: entry.endMinute,
    })),
    ...input.routines.filter((entry) => entry.day === day).map((entry) => ({
      id: `routine-${entry.id}`,
      kind: 'routine' as const,
      title: entry.title,
      detail: entry.venue?.trim() || entry.category,
      start: entry.startMinute,
      end: entry.endMinute,
    })),
  ].sort((left, right) => left.start - right.start);

  const tasks = input.todos
    .filter((todo) => !todo.isCompleted)
    .sort((left, right) => {
      const date = (toDate(left.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (toDate(right.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER);
      return date || PRIORITY[left.priority] - PRIORITY[right.priority];
    })
    .slice(0, 3);
  const minuteNow = now.getHours() * 60 + now.getMinutes();
  let cursor = Math.max(8 * 60, minuteNow);
  const planned: DailyPlanItem[] = [];

  for (const todo of tasks) {
    while (true) {
      const collision = fixed.find((entry) => cursor < entry.end && cursor + 45 > entry.start);
      if (!collision) break;
      cursor = collision.end + 10;
    }
    if (cursor + 45 > 22 * 60) break;
    planned.push({
      id: `task-${todo.id}`,
      kind: 'task',
      title: todo.title,
      detail: todo.subjectName || `${DAY_FULL[day]} plan`,
      start: cursor,
      end: cursor + 45,
    });
    cursor += 55;
  }

  return [...fixed, ...planned]
    .sort((left, right) => left.start - right.start)
    .map((entry) => ({ ...entry, detail: `${minutesToLabel(entry.start)} to ${minutesToLabel(entry.end)} · ${entry.detail}` }));
}
