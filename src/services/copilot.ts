import { doc, getDocs, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { askSources, buildContext, copilotTurn, type CopilotTurn } from '@/lib/ai';
import { formatDue, parseDueDate, toDate } from '@/lib/dates';
import { paths } from '@/lib/paths';
import {
  DAY_FULL,
  minutesToLabel,
  parseCourseCode,
  todayIndex,
  type ClassBlock,
  type SourceDocument,
  type Subject,
  type Todo,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import { logLecture } from '@/services/lectureLog';
import { resolveClasses } from '@/services/timetable';

/**
 * What the assistant is actually allowed to do.
 *
 * Every tool reads or writes through the same paths the screens use, so there
 * is no second, looser way into a student's data — and each one returns a
 * summary the UI shows verbatim. A student should never have to take the
 * model's word for what it did.
 */

async function loadSubjects(uid: string): Promise<Subject[]> {
  const snapshot = await getDocs(paths.subjects(getDb(), uid));
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as Subject);
}

async function loadClasses(uid: string): Promise<ClassBlock[]> {
  const snapshot = await getDocs(paths.classes(getDb(), uid));
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as ClassBlock);
}

async function loadTodos(uid: string): Promise<Todo[]> {
  const snapshot = await getDocs(query(paths.todos(getDb(), uid), orderBy('dueDate', 'asc')));
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }) as Todo);
}

/** Ranked matches for a name or a code, best first. */
export function rankSubjects(subjects: Subject[], query: string): Subject[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return subjects.slice(0, 5);

  const code = parseCourseCode(query).code.toLowerCase();

  const scored = subjects.map((subject) => {
    const name = subject.name.toLowerCase();
    const subjectCode = parseCourseCode(subject.moduleCode).code.toLowerCase();

    let score = 0;
    if (code && subjectCode === code) score = 100;
    else if (name === needle) score = 90;
    else if (subjectCode && needle.includes(subjectCode)) score = 80;
    else if (name.includes(needle) || needle.includes(name)) score = 60;
    else {
      // Word overlap, so "research method" finds "Research Methods".
      const words = needle.split(/\s+/).filter((word) => word.length > 3);
      score = words.filter((word) => name.includes(word)).length * 20;
    }
    return { subject, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.subject);
}

/** The two-line brief the assistant starts every conversation with. */
export async function copilotBrief(uid: string): Promise<string> {
  const [subjects, classes] = await Promise.all([loadSubjects(uid), loadClasses(uid)]);
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = todayIndex();

  const live = resolveClasses(classes, subjects)
    .filter((block) => block.day === today && block.endMinute > minutes)
    .sort((a, b) => a.startMinute - b.startMinute)[0];

  return [
    `It is ${DAY_FULL[today]}, ${now.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })}, ${minutesToLabel(minutes)}.`,
    subjects.length
      ? `Their subjects: ${subjects
          .map((subject) => `${subject.name}${subject.moduleCode ? ` (${subject.moduleCode})` : ''}`)
          .join(', ')}.`
      : 'They have no subjects in their library yet.',
    live
      ? `Next up today: ${live.subjectName || live.title} at ${minutesToLabel(live.startMinute)}${
          live.venue ? ` in ${live.venue}` : ''
        }.`
      : 'Nothing left on their timetable today.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

type ToolResult = { result: unknown; summary?: string };

export async function runCopilotTool(
  uid: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const text = (key: string): string => String(args[key] ?? '').trim();

  switch (name) {
    case 'find_subject': {
      const matches = rankSubjects(await loadSubjects(uid), text('query'));
      return {
        result: matches.map((subject) => ({
          subjectId: subject.id,
          name: subject.name,
          code: subject.moduleCode,
        })),
      };
    }

    case 'create_task': {
      const title = text('title');
      if (!title) return { result: { error: 'A task needs a title.' } };

      const subjects = await loadSubjects(uid);
      const subject = subjects.find((entry) => entry.id === text('subjectId')) ?? null;
      const due = parseDueDate(text('dueDate') || null, text('dueTime') || null);

      const db = getDb();
      const ref = doc(paths.todos(db, uid));
      await setDoc(ref, {
        title,
        dueDate: due,
        isCompleted: false,
        subjectId: subject?.id ?? null,
        subjectName: subject?.name ?? null,
        priority: ['low', 'medium', 'high'].includes(text('priority')) ? text('priority') : 'medium',
        subTasks: [],
        source: 'manual',
        sourceDocumentId: null,
        createdAt: serverTimestamp(),
        completedAt: null,
      });

      const when = due ? formatDue(toDate(due)) : 'no deadline';
      return {
        result: { created: true, todoId: ref.id, due: when },
        summary: `Added “${title}”${subject ? ` to ${subject.name}` : ''} · ${when}`,
      };
    }

    case 'get_schedule': {
      const [subjects, classes] = await Promise.all([loadSubjects(uid), loadClasses(uid)]);
      const resolved = resolveClasses(classes, subjects);
      const when = text('when').toLowerCase() || 'next';
      const today = todayIndex();
      const minutes = new Date().getHours() * 60 + new Date().getMinutes();

      const named = DAY_FULL.findIndex((day) => day.toLowerCase() === when);
      const day =
        named >= 0
          ? named
          : when === 'tomorrow'
            ? (today + 1) % 7
            : when === 'week'
              ? -1
              : today;

      const wanted = resolved
        .filter((block) => (day === -1 ? true : block.day === day))
        .filter((block) => (when === 'next' ? block.day !== today || block.endMinute > minutes : true))
        .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);

      return {
        result: wanted.slice(0, when === 'next' ? 1 : 20).map((block) => ({
          subject: block.subjectName || block.title,
          code: block.code,
          section: block.section ?? null,
          type: block.kind,
          day: DAY_FULL[block.day],
          starts: minutesToLabel(block.startMinute),
          ends: minutesToLabel(block.endMinute),
          room: block.venue,
        })),
      };
    }

    case 'get_tasks': {
      const todos = await loadTodos(uid);
      const subjectId = text('subjectId');

      return {
        result: todos
          .filter((todo) => !todo.isCompleted)
          .filter((todo) => (subjectId ? todo.subjectId === subjectId : true))
          .slice(0, 20)
          .map((todo) => ({
            title: todo.title,
            subject: todo.subjectName,
            due: formatDue(toDate(todo.dueDate)),
            priority: todo.priority,
          })),
      };
    }

    case 'search_material': {
      const subjectId = text('subjectId');
      const question = text('question');
      if (!subjectId || !question) {
        return { result: { error: 'Needs both a subject and a question.' } };
      }

      const snapshot = await getDocs(
        query(paths.documents(getDb(), uid, subjectId), orderBy('createdAt', 'asc'))
      );
      const context = buildContext(
        snapshot.docs.map((entry) => {
          const data = entry.data() as SourceDocument;
          return { title: data.fileName || data.title, text: data.rawText ?? '' };
        })
      );

      if (!context) {
        return { result: { error: 'Nothing has been uploaded for this subject yet.' } };
      }

      const answer = await askSources(context, [], question);
      return { result: { answer } };
    }

    case 'log_lecture': {
      const subjects = await loadSubjects(uid);
      const subject = subjects.find((entry) => entry.id === text('subjectId'));
      const entry = text('entry');
      if (!subject || !entry) return { result: { error: 'Needs a subject and what was covered.' } };

      const logged = await logLecture(uid, {
        subjectId: subject.id,
        subjectName: subject.name,
        entry,
      });

      return {
        result: { logged: true, wroteNotes: logged.rundown !== null },
        summary: `Logged a ${subject.name} class`,
      };
    }

    default:
      return { result: { error: `No such tool: ${name}` } };
  }
}

/** One turn, wired to this student's data. */
export async function askCopilot(
  uid: string,
  message: string,
  history: CopilotTurn[]
): Promise<{ reply: string; actions: { tool: string; summary: string }[] }> {
  return copilotTurn({
    message,
    history,
    brief: await copilotBrief(uid),
    run: (name, args) => runCopilotTool(uid, name, args),
  });
}
