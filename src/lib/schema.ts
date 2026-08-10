import type { Timestamp } from 'firebase/firestore';

export type Priority = 'low' | 'medium' | 'high';

/** users/{uid}/subjects/{subjectId} */
export type Subject = {
  id: string;
  name: string;
  moduleCode: string | null;
  color: string;
  documentCount: number;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
};

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
  status: 'ready' | 'parsing' | 'failed';
  error?: string | null;
  createdAt: Timestamp | null;
};

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

/** Deterministic palette so a subject keeps the same colour across devices. */
const SUBJECT_COLORS = ['#B4552D', '#2E6F5E', '#B4832A', '#4C5FA8', '#8A4B86', '#B0443E'];

export function colorForSubject(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
}
