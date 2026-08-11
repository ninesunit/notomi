import type { Timestamp } from 'firebase/firestore';

export type Priority = 'low' | 'medium' | 'high';

/** users/{uid}/semesters/{semesterId} */
export type Semester = {
  id: string;
  name: string;
  year: number;
  term: string;
  isCurrent: boolean;
  gpaTarget?: number | null;
  /** Manual ordering; lower sorts first. */
  order: number;
  createdAt: Timestamp | null;
};

/**
 * Suggestions, not an enum.
 *
 * Universities do not agree on what a term is called — trimesters, phases,
 * blocks, quarters — so the term is a free string. These are offered as chips
 * to save typing, alongside whatever the student has already used.
 */
export const TERM_SUGGESTIONS = [
  'Semester 1',
  'Semester 2',
  'Trimester 1',
  'Quarter 1',
  'Summer',
  'Winter',
];

/** Terms already in use, newest first, for the picker. */
export function knownTerms(semesters: { term: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const semester of semesters) {
    const term = semester.term?.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

/**
 * 4.0-scale grade points. Kept here rather than in the UI so the planner and
 * the calculator can never disagree about what a B+ is worth.
 */
export const GRADE_POINTS: Record<string, number> = {
  'A+': 4.0,
  A: 4.0,
  'A-': 3.7,
  'B+': 3.3,
  B: 3.0,
  'B-': 2.7,
  'C+': 2.3,
  C: 2.0,
  'C-': 1.7,
  'D+': 1.3,
  D: 1.0,
  F: 0.0,
};

export const GRADE_OPTIONS = Object.keys(GRADE_POINTS);

/**
 * Credit-weighted mean, ignoring subjects with no grade recorded yet.
 *
 * Both fields are required rather than optional: with `creditHours?` a caller
 * whose rows name the field something else stays structurally assignable and
 * silently gets a GPA of null over zero credits.
 */
export function calculateGpa(
  entries: { creditHours: number | null | undefined; grade: string | null | undefined }[]
): { gpa: number | null; credits: number; graded: number } {
  let points = 0;
  let credits = 0;
  let graded = 0;

  for (const entry of entries) {
    const weight = entry.creditHours ?? 0;
    credits += weight;
    const grade = entry.grade ?? '';
    if (!(grade in GRADE_POINTS) || weight <= 0) continue;
    points += GRADE_POINTS[grade] * weight;
    graded += weight;
  }

  return { gpa: graded > 0 ? points / graded : null, credits, graded };
}

/**
 * Splits "LDCW6123 TC1L" into the course and the session it identifies.
 *
 * A university schedule prints both in the same cell, and treating the whole
 * string as the course code is what made one subject arrive as two: LDCW6123
 * TC1L and LDCW6123 TL1L look like different courses, so the importer created a
 * folder for each and the student had to merge them by hand.
 *
 * The two are told apart by how many digits they carry. A course code runs to
 * three or more (CS2040, LDCW6123, MA1101R); a section code carries one or two
 * (TC1L, TL2L, G3, L1). That rule holds across every schedule format I have
 * seen, and where it does not, the worst case is a section kept as part of the
 * code — which is what happened for everything before this.
 */
export function parseCourseCode(raw: string | null | undefined): {
  code: string;
  section: string | null;
} {
  const tokens = (raw ?? '')
    .toUpperCase()
    .split(/[\s,/|]+/)
    .map((token) => token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) return { code: '', section: null };

  const isCourse = (token: string) => /[A-Z]/.test(token) && /\d{3,}/.test(token);
  const isSection = (token: string) => /^[A-Z]{0,3}\d{1,2}[A-Z]{0,2}$/.test(token);

  const code = tokens.find(isCourse) ?? null;
  const section = tokens.find((token) => token !== code && isSection(token)) ?? null;

  // Nothing course-shaped: keep what was printed rather than inventing a split.
  if (!code) return { code: tokens.join(' '), section: null };

  return { code, section };
}

/**
 * Calms a name a schedule printed in block capitals.
 *
 * University systems shout: "FUNDAMENTALS OF DIGITAL MEDIA" is what comes off
 * the screenshot, and a library of those reads like an argument. Only strings
 * that are entirely uppercase are touched — anything with a lowercase letter in
 * it was written that way deliberately — and codes and roman numerals keep
 * their capitals.
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on',
  'or', 'the', 'to', 'via', 'vs', 'with',
]);

export function tidyName(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text || text !== text.toUpperCase() || !/[A-Z]{4}/.test(text)) return text;

  return text
    .toLowerCase()
    .split(' ')
    .map((word, index) => {
      // A code keeps its shape: CS2040, MA1101R, IT-101.
      if (/\d/.test(word)) return word.toUpperCase();
      if (/^(i{1,3}|iv|vi{0,3}|ix|xi{0,3})$/.test(word)) return word.toUpperCase();
      if (index > 0 && MINOR_WORDS.has(word)) return word;
      // Capitalise after a bracket or hyphen too: "(part two)" → "(Part Two)".
      return word.replace(/(^|[([{\-/])([a-z])/g, (_, prefix: string, letter: string) =>
        `${prefix}${letter.toUpperCase()}`
      );
    })
    .join(' ');
}

/** users/{uid}/subjects/{subjectId} */
export type Subject = {
  id: string;
  name: string;
  moduleCode: string | null;
  color: string;
  /** Folder icon. A single emoji, or null to fall back to the book glyph. */
  emoji: string | null;
  /** Free-text label shown on the card banner, e.g. "Core" or "Elective". */
  tag: string | null;
  documentCount: number;
  /** Which semester this subject belongs to; null until the planner assigns it. */
  semesterId: string | null;
  creditHours: number;
  /** Recorded grade, keyed into GRADE_POINTS. */
  grade: string | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

/**
 * Palette offered when a student picks a folder colour. The generated colour
 * from colorForSubject is always one of these, so a manual choice and an
 * automatic one are visually the same family.
 */
export const SUBJECT_PALETTE = [
  { name: 'Clay', value: '#B4552D' },
  { name: 'Pine', value: '#2E6F5E' },
  { name: 'Amber', value: '#B4832A' },
  { name: 'Indigo', value: '#4C5FA8' },
  { name: 'Plum', value: '#8A4B86' },
  { name: 'Rose', value: '#B0443E' },
  { name: 'Slate', value: '#4A5568' },
  { name: 'Teal', value: '#2B7A78' },
];

/** Emoji offered in the folder picker — one row of academic shorthand. */
export const SUBJECT_EMOJI = [
  '📘', '📐', '🧪', '🧬', '💻', '⚖️', '🩺', '🎨',
  '🌍', '🧠', '📊', '🏛️', '🔬', '🎼', '🗣️', '⚙️',
];

/** users/{uid}/subjects/{subjectId}/documents/{documentId} */
export type SourceDocument = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Full extracted text. Passed wholesale into Gemini's long context window. */
  rawText: string;
  charCount: number;
  /** R2 object key: users/{userId}/{subjectId}/{fileName} */
  r2FileKey: string;
  /** Public or presigned viewing URL for the original file. */
  r2FileUrl: string;
  moduleCode: string | null;
  summary: string | null;
  /** Publication-grade Markdown notes generated by aiNotes. */
  notes: string | null;
  notesGeneratedAt: Timestamp | null;
  /** How the text was obtained — parsing locally, or Gemini OCR/transcription. */
  sourceKind: FileKind;
  status: 'ready' | 'parsing' | 'failed';
  error?: string | null;
  createdAt: Timestamp | null;
};

/** What the file is, which decides how its text is extracted. */
export type FileKind = 'pdf' | 'docx' | 'pptx' | 'text' | 'image' | 'audio' | 'video';

/** users/{uid}/subjects/{subjectId}/chats/{chatId} */
export type ChatSession = {
  id: string;
  title: string;
  /** Scopes the chat to one document; null means the whole subject. */
  documentId: string | null;
  messageCount: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

/** users/{uid}/subjects/{subjectId}/chats/{chatId}/messages/{messageId} */
export type ChatRecord = {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  createdAt: Timestamp | null;
};

/* ------------------------------------------------------------------ *
 * Timetable
 * ------------------------------------------------------------------ */

/**
 * users/{uid}/classes/{classId} — the academic timetable.
 *
 * Every block here belongs to a real subject in the library. Gym sessions and
 * study blocks live in a separate collection (RoutineBlock) so academic logic —
 * "what class am I in", "which subject's notes do I need" — never has to filter
 * out a swim.
 */
export type ClassBlock = {
  id: string;
  title: string;
  /** Lecture, tutorial, lab… whatever the schedule called it. */
  kind: string | null;
  /**
   * Section or session id, e.g. TC1L, TL2L, G3.
   *
   * It identifies which of a course's several weekly sessions this block is,
   * and belongs to the block rather than to the subject — one course has one
   * code and many sections.
   */
  section?: string | null;
  /** The subject this class teaches. Blocks without one are not rendered. */
  subjectId: string | null;
  subjectName: string | null;
  /** 0 = Monday … 6 = Sunday, matching DAY_LABELS. */
  day: number;
  /** Minutes from midnight, so comparisons and layout are plain arithmetic. */
  startMinute: number;
  endMinute: number;
  venue: string | null;
  color: string;
  createdAt: Timestamp | null;
};

/**
 * users/{uid}/routines/{routineId} — the non-academic overlay.
 *
 * Deliberately a separate collection rather than a `kind` field on ClassBlock:
 * a routine has no subject, no notes and no bearing on GPA, and mixing the two
 * would put "is this actually a class?" checks through every academic query.
 * The overlay can be toggled off without touching the timetable underneath.
 */
export type RoutineBlock = {
  id: string;
  title: string;
  /** gym | study | meal | commute | work | other — drives the icon. */
  category: string;
  day: number;
  startMinute: number;
  endMinute: number;
  venue: string | null;
  color: string;
  createdAt: Timestamp | null;
};

export const ROUTINE_CATEGORIES: { id: string; label: string; emoji: string; color: string }[] = [
  { id: 'study', label: 'Study', emoji: '📖', color: '#4C5FA8' },
  { id: 'gym', label: 'Gym', emoji: '🏋️', color: '#2E6F5E' },
  { id: 'meal', label: 'Meal', emoji: '🍽️', color: '#B4832A' },
  { id: 'commute', label: 'Commute', emoji: '🚌', color: '#4A5568' },
  { id: 'work', label: 'Work', emoji: '💼', color: '#8A4B86' },
  { id: 'other', label: 'Other', emoji: '📌', color: '#6F6A5F' },
];

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_FULL = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** JS getDay() is Sunday-first; the timetable is Monday-first. */
export function todayIndex(now = new Date()): number {
  return (now.getDay() + 6) % 7;
}

export function minutesToLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${display}${suffix}` : `${display}:${String(minute).padStart(2, '0')}${suffix}`;
}

/**
 * "9:00 AM" — the unambiguous form, for anywhere a student is setting a time
 * rather than reading one. minutesToLabel is the compact form for display.
 */
export function minutesTo12h(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * Parses a clock time into minutes from midnight.
 *
 * Deliberately forgiving: this reads both what a student types into a field and
 * what Gemini lifts off a schedule, and real schedules print "8:00 AM",
 * "8.00am", "0800" and "13:00" interchangeably. Insisting on 24-hour HH:MM
 * silently dropped every class on a timetable that used 12-hour times.
 *
 * Returns null for anything genuinely unparseable, which is what makes a row
 * get flagged rather than guessed at.
 */
export function parseClock(value: string): number | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;

  const match = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(text);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.[0];

  if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    // 12am is midnight and 12pm is noon — the one case the +12 rule gets wrong.
    if (meridiem === 'p') hour = hour === 12 ? 12 : hour + 12;
    else hour = hour === 12 ? 0 : hour;
  } else if (hour > 23) {
    // "0800" style: no separator, no meridiem, four digits.
    return null;
  }

  return hour * 60 + minute;
}

export function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Study sessions and flashcards
 * ------------------------------------------------------------------ */

/** users/{uid}/sessions/{sessionId} — one completed focus or study block. */
export type StudySession = {
  id: string;
  subjectId: string | null;
  subjectName: string | null;
  minutes: number;
  mode: 'focus' | 'quiz' | 'flashcards' | 'tutor' | 'exam';
  /** Local YYYY-MM-DD, so a streak is a set membership test, not a scan. */
  dayKey: string;
  createdAt: Timestamp | null;
};

/** users/{uid}/subjects/{subjectId}/flashcards/{cardId} */
export type Flashcard = {
  id: string;
  front: string;
  back: string;
  concept: string | null;
  /** new = unseen, known = answered confidently, review = flagged to revisit. */
  status: 'new' | 'known' | 'review';
  sourceDocumentId: string | null;
  createdAt: Timestamp | null;
  lastSeenAt: Timestamp | null;
};

/* ------------------------------------------------------------------ *
 * Lecture log
 * ------------------------------------------------------------------ */

/**
 * users/{uid}/subjects/{subjectId}/lectures/{lectureId}
 *
 * One class, as the student describes it in a sentence — "today we did topic 4
 * and got to 4.2". Everything structured hangs off that sentence: the topic and
 * the section are what let the log be filed under a topic rather than a date,
 * and the rundown is what makes it worth reading back before an exam.
 */
export type LectureLog = {
  id: string;
  subjectId: string;
  subjectName: string | null;
  /** Verbatim, so a bad reading can always be re-run against the original. */
  entry: string;
  title: string;
  /** The chapter or topic covered, normalised by Gemini from the entry. */
  topic: string | null;
  /** How far inside the topic the class reached, e.g. "4.2". */
  reachedSection: string | null;
  /** Markdown rundown of what the class covered. */
  notes: string | null;
  keyPoints: string[];
  /** What to read or revise before the next class. */
  followUps: string[];
  /** Set when the entry was logged against a timetable block. */
  classId: string | null;
  /** Local YYYY-MM-DD of the class, so a term's logs sort without dates. */
  dayKey: string;
  createdAt: Timestamp | null;
};

/** Gemini's read of one lecture log entry. */
export type LectureRundown = {
  title: string;
  topic: string | null;
  reachedSection: string | null;
  notes: string;
  keyPoints: string[];
  followUps: string[];
};

/* ------------------------------------------------------------------ *
 * Tutorials, labs and assignments
 * ------------------------------------------------------------------ */

export type AssignmentKind = 'assignment' | 'tutorial' | 'lab' | 'project';

export const ASSIGNMENT_KINDS: {
  id: AssignmentKind;
  label: string;
  emoji: string;
  color: string;
}[] = [
  { id: 'assignment', label: 'Assignment', emoji: '📝', color: '#B4552D' },
  { id: 'tutorial', label: 'Tutorial', emoji: '✏️', color: '#4C5FA8' },
  { id: 'lab', label: 'Lab', emoji: '🧪', color: '#2E6F5E' },
  { id: 'project', label: 'Project', emoji: '🚀', color: '#8A4B86' },
];

export type AssignmentStep = {
  id: string;
  title: string;
  detail: string | null;
  isCompleted: boolean;
};

/** users/{uid}/subjects/{subjectId}/assignments/{assignmentId} */
export type Assignment = {
  id: string;
  subjectId: string;
  subjectName: string | null;
  title: string;
  kind: AssignmentKind;
  /** Gemini's rundown of what the brief actually asks for. */
  brief: string | null;
  /** Extracted text of the brief, kept so it can be re-analysed offline. */
  sourceText: string | null;
  sourceFileName: string | null;
  steps: AssignmentStep[];
  deliverables: string[];
  markingNotes: string | null;
  estimatedHours: number | null;
  dueDate: Timestamp | null;
  /** The to-do created for the deadline, so deleting this can clean it up. */
  todoId: string | null;
  status: 'todo' | 'in_progress' | 'done';
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

/** What Gemini returns for an uploaded brief. */
export type AssignmentBreakdown = {
  title: string;
  /** assignment | tutorial | lab | project */
  kind: string | null;
  summary: string;
  steps: { title: string; detail: string | null }[];
  deliverables: string[];
  markingNotes: string | null;
  estimatedHours: number | null;
  /** ISO YYYY-MM-DD. */
  dueDate: string | null;
  /** 24-hour HH:MM. */
  dueTime: string | null;
};

export function assignmentKind(raw: string | null | undefined): AssignmentKind {
  const value = (raw ?? '').toLowerCase();
  const match = ASSIGNMENT_KINDS.find((option) => value.includes(option.id));
  if (match) return match.id;
  // "Practical" and "workshop" are what a lab is called at half of all
  // universities; "problem set" is a tutorial by another name.
  if (/practical|workshop|experiment/.test(value)) return 'lab';
  if (/problem set|exercise|worksheet|tutorial/.test(value)) return 'tutorial';
  if (/project|capstone|dissertation|thesis/.test(value)) return 'project';
  return 'assignment';
}

/** users/{uid}/todos/{todoId} */
export type SubTask = {
  id: string;
  title: string;
  isCompleted: boolean;
};

export type Todo = {
  id: string;
  title: string;
  dueDate: Timestamp | null;
  isCompleted: boolean;
  subjectId: string | null;
  subjectName: string | null;
  priority: Priority;
  subTasks: SubTask[];
  /** Set when the deadline was auto-extracted from an uploaded syllabus. */
  source: 'manual' | 'syllabus';
  sourceDocumentId: string | null;
  createdAt: Timestamp | null;
  completedAt: Timestamp | null;
};

/** users/{uid}/weak_concepts/{conceptId} */
export type WeakConcept = {
  id: string;
  subjectId: string;
  subjectName: string | null;
  concept: string;
  question: string;
  correctAnswer: string;
  explanation: string | null;
  timesMissed: number;
  timesReviewed: number;
  /** Leitner box: 0 = new/failed, higher = longer interval. */
  box: number;
  lastMissedAt: Timestamp | null;
  nextReviewAt: Timestamp | null;
};

/** What Gemini returns when we analyse a freshly uploaded document. */
export type ExtractedDeadline = {
  title: string;
  /** ISO YYYY-MM-DD. */
  dueDate: string | null;
  /** 24-hour HH:MM when the source states one. */
  dueTime: string | null;
  /** assignment | exam | quiz | lab | project | reading | presentation | other */
  kind: string | null;
};

export type ExtractedMetadata = {
  moduleCode: string | null;
  subjectName: string | null;
  summary: string | null;
  deadlines: ExtractedDeadline[];
};

export type QuizQuestion = {
  question: string;
  options: string[];
  correctAnswerIndex: number;
  explanation: string;
  concept?: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'model';
  text: string;
  pending?: boolean;
  error?: boolean;
};

export type PodcastLine = {
  speaker: string;
  text: string;
};

/** One class block as Gemini reads it off a schedule screenshot. */
export type ExtractedClass = {
  title: string;
  /** Module/course code where the schedule prints one, e.g. "CS2040". */
  code: string | null;
  /** Section or session identifier for this block, e.g. "TC1L", "TL2L", "G3". */
  section: string | null;
  kind: string | null;
  /** Day name as printed on the schedule; mapped to an index on import. */
  day: string;
  /** 24-hour HH:MM. */
  start: string;
  end: string;
  venue: string | null;
};

export type GeneratedCard = {
  front: string;
  back: string;
  concept: string | null;
};

/** A free-text question the tutor or exam asks, with its marking guide. */
export type OpenQuestion = {
  question: string;
  /** What a full-mark answer must contain — used to grade, never shown first. */
  modelAnswer: string;
  concept: string | null;
};

/** Gemini's assessment of a student's free-text answer. */
export type AnswerGrade = {
  /** 0-100, so partial credit is expressible. */
  score: number;
  verdict: string;
  whatWentWell: string;
  whatWasMissing: string;
  /** The next question in a Socratic exchange; null ends the thread. */
  followUp: string | null;
};

/** Deterministic palette so a subject keeps the same colour across devices. */
const SUBJECT_COLORS = ['#B4552D', '#2E6F5E', '#B4832A', '#4C5FA8', '#8A4B86', '#B0443E'];

export function colorForSubject(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
}
