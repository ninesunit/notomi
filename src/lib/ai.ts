import {
  getGenerativeModel,
  Schema,
  type GenerativeModel,
  type ModelParams,
} from 'firebase/ai';
import { GEMINI_MODEL, getAiClient } from './firebase';
import type { ExtractedMetadata, PodcastLine, QuizQuestion } from './schema';

/**
 * Gemini's context window is well over a million tokens, so Notomi skips RAG
 * entirely: the whole corpus for a subject is pasted into the prompt. This cap
 * exists only to stay inside the window and keep latency sane on a phone.
 * ~4 chars per token, leaving generous headroom for the response.
 */
export const MAX_CONTEXT_CHARS = 600_000;

export class AiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'AiError';
  }
}

function model(params: Omit<ModelParams, 'model'> = {}): GenerativeModel {
  return getGenerativeModel(getAiClient(), { model: GEMINI_MODEL, ...params });
}

/** Turns an unknown SDK failure into something worth showing a student. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/API key not valid/i.test(raw)) return 'Firebase API key rejected. Check your .env values.';
  if (/AI Logic|not enabled|SERVICE_DISABLED|has not been used/i.test(raw)) {
    return 'Firebase AI Logic is not enabled yet. Enable it in the Firebase console under Build > AI Logic.';
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return 'Gemini rate limit reached. Wait a moment and try again.';
  }
  if (/permission|403/i.test(raw)) return 'Permission denied by Firebase AI Logic.';
  if (/network|fetch|Failed to fetch/i.test(raw)) return 'Network error talking to Gemini.';
  return raw;
}

/**
 * Gemini occasionally wraps JSON in prose or a fenced block even in JSON mode.
 * Recover the outermost object/array rather than failing the whole flow.
 */
export function parseJson<T>(raw: string): T {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new AiError('Gemini returned a response that was not valid JSON.');
  }
}

/** Clips a corpus to the context budget, keeping head and tail of each source. */
export function buildContext(sources: { title: string; text: string }[]): string {
  const usable = sources.filter((s) => s.text.trim().length > 0);
  if (usable.length === 0) return '';

  const budgetPerSource = Math.floor(MAX_CONTEXT_CHARS / usable.length);

  return usable
    .map((source) => {
      let body = source.text;
      if (body.length > budgetPerSource) {
        const half = Math.floor(budgetPerSource / 2);
        body = `${body.slice(0, half)}\n\n[... middle of this document omitted for length ...]\n\n${body.slice(-half)}`;
      }
      return `<source title="${source.title.replace(/"/g, "'")}">\n${body}\n</source>`;
    })
    .join('\n\n');
}

async function generate(params: Omit<ModelParams, 'model'>, prompt: string): Promise<string> {
  try {
    const result = await model(params).generateContent(prompt);
    return result.response.text();
  } catch (error) {
    throw new AiError(describe(error), error);
  }
}

/* ------------------------------------------------------------------ *
 * Task 2 — metadata extraction from a freshly uploaded document
 * ------------------------------------------------------------------ */

const metadataSchema = Schema.object({
  properties: {
    moduleCode: Schema.string({
      description: 'Course/module code such as "CS3243". Empty string if absent.',
    }),
    subjectName: Schema.string({ description: 'Human readable subject name.' }),
    summary: Schema.string({ description: '2-4 sentence summary of the document.' }),
    deadlines: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          dueDate: Schema.string({ description: 'ISO 8601 date (YYYY-MM-DD), or empty if unknown.' }),
        },
        optionalProperties: ['dueDate'],
      }),
    }),
  },
  optionalProperties: ['moduleCode'],
});

export async function extractMetadata(text: string): Promise<ExtractedMetadata> {
  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: metadataSchema,
        temperature: 0.1,
      },
    },
    `Analyze this syllabus/lecture document and return the requested JSON.

Rules:
- "moduleCode": the official course code if one appears (e.g. "MA1521"), else "".
- "subjectName": the subject/course this belongs to, in title case. Never empty — infer it from the content if it is not stated.
- "summary": 2-4 sentences on what this document covers.
- "deadlines": every assessment, assignment, exam or submission with a date. Use ISO YYYY-MM-DD. If a date has no year, assume the academic year the document implies. Omit entries with no discernible date. Return [] when there are none.

DOCUMENT:
${text.slice(0, MAX_CONTEXT_CHARS)}`
  );

  const parsed = parseJson<Partial<ExtractedMetadata>>(raw);
  return {
    moduleCode: parsed.moduleCode?.trim() || null,
    subjectName: parsed.subjectName?.trim() || null,
    summary: parsed.summary?.trim() || null,
    deadlines: Array.isArray(parsed.deadlines)
      ? parsed.deadlines
          .filter((d) => d && typeof d.title === 'string' && d.title.trim())
          .map((d) => ({ title: d.title.trim(), dueDate: d.dueDate?.trim() || null }))
      : [],
  };
}

/* ------------------------------------------------------------------ *
 * Task 4 — grounded multi-source chat
 * ------------------------------------------------------------------ */

export const READER_SYSTEM_PROMPT =
  'You are Notomi, an expert tutor. Use ONLY the provided source text to answer questions. ' +
  'Cite your answers using inline quotes: quote the exact supporting sentence in double quotes ' +
  'and name the source title in brackets, e.g. "photosynthesis converts light energy" [Lecture 3]. ' +
  'If the sources do not contain the answer, say so plainly instead of guessing. ' +
  'Be concise and well structured; prefer short paragraphs and bullet lists.';

export type ChatTurn = { role: 'user' | 'model'; text: string };

export async function askSources(
  context: string,
  history: ChatTurn[],
  question: string
): Promise<string> {
  const chatModel = model({
    systemInstruction: `${READER_SYSTEM_PROMPT}\n\nSOURCES:\n${context}`,
    generationConfig: { temperature: 0.3 },
  });

  try {
    const chat = chatModel.startChat({
      history: history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    });
    const result = await chat.sendMessage(question);
    return result.response.text();
  } catch (error) {
    throw new AiError(describe(error), error);
  }
}

/* ------------------------------------------------------------------ *
 * Task 4 — audio overview (2-speaker podcast transcript)
 * ------------------------------------------------------------------ */

const podcastSchema = Schema.array({
  items: Schema.object({
    properties: {
      speaker: Schema.string({ description: 'Either "Alex" or "Sam".' }),
      text: Schema.string(),
    },
  }),
});

export async function generatePodcast(context: string): Promise<PodcastLine[]> {
  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: podcastSchema,
        temperature: 0.8,
      },
    },
    `Turn these notes into a 2-speaker podcast transcript discussing the core concepts.

Speakers are "Alex" (the curious host who asks the questions a student would ask) and "Sam" (the expert who explains clearly with analogies).
- 18-28 alternating turns, starting with Alex.
- Conversational and spoken-word: no markdown, no headings, no stage directions, no bracketed asides.
- Cover the genuinely important concepts, not the admin details.
- End with Sam giving a short recap of the key takeaways.

NOTES:
${context}`
  );

  const parsed = parseJson<PodcastLine[]>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AiError('Gemini did not return any podcast lines.');
  }
  return parsed
    .filter((line) => line && typeof line.text === 'string' && line.text.trim())
    .map((line, index) => ({
      speaker: line.speaker?.trim() || (index % 2 === 0 ? 'Alex' : 'Sam'),
      text: line.text.trim(),
    }));
}

/* ------------------------------------------------------------------ *
 * Task 5 — quiz generation
 * ------------------------------------------------------------------ */

const quizSchema = Schema.array({
  items: Schema.object({
    properties: {
      question: Schema.string(),
      options: Schema.array({ items: Schema.string() }),
      correctAnswerIndex: Schema.number({ description: 'Zero-based index into options.' }),
      explanation: Schema.string(),
      concept: Schema.string({ description: 'The 2-5 word concept being tested.' }),
    },
    optionalProperties: ['concept'],
  }),
});

export async function generateQuiz(
  context: string,
  options: { count?: number; focusConcepts?: string[] } = {}
): Promise<QuizQuestion[]> {
  const count = options.count ?? 10;
  const focus = options.focusConcepts?.length
    ? `\n\nThe student previously got these concepts wrong. Weight at least half the questions toward them:\n${options.focusConcepts.map((c) => `- ${c}`).join('\n')}`
    : '';

  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: quizSchema,
        temperature: 0.6,
      },
    },
    `Generate a ${count}-question multiple-choice quiz based strictly on the provided text.

Rules:
- Exactly 4 options per question, exactly one correct.
- "correctAnswerIndex" is the zero-based index of the correct option.
- Distractors must be plausible and drawn from the same material, not obviously wrong.
- "explanation": one or two sentences saying why the answer is right, referencing the source material.
- "concept": the specific 2-5 word topic the question tests.
- Test understanding, not trivia about formatting or page numbers.${focus}

TEXT:
${context}`
  );

  const parsed = parseJson<QuizQuestion[]>(raw);
  const valid = (Array.isArray(parsed) ? parsed : []).filter(
    (q) =>
      q &&
      typeof q.question === 'string' &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      typeof q.correctAnswerIndex === 'number' &&
      q.correctAnswerIndex >= 0 &&
      q.correctAnswerIndex < q.options.length
  );

  if (valid.length === 0) throw new AiError('Gemini did not return any usable questions.');
  return valid.map((q) => ({ ...q, explanation: q.explanation || '' }));
}
