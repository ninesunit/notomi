import {
  getGenerativeModel,
  Schema,
  type GenerativeModel,
  type ModelParams,
} from 'firebase/ai';
import { GEMINI_MODEL, getAiClient, getModel, isAppCheckEnabled } from '@/services/firebase';
import type {
  AnswerGrade,
  ExtractedClass,
  ExtractedMetadata,
  GeneratedCard,
  OpenQuestion,
  PodcastLine,
  QuizQuestion,
} from './schema';

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

/**
 * The SDK's default timeout is generous enough that a stalled request looks
 * like a frozen upload. Two minutes is well past a normal long-context call
 * and still fails while the student is watching.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Google retires and renames Gemini models on its own schedule, and the model
 * id lives in an env var that is easy to set to something that no longer
 * exists. Rather than take every AI feature down, the first "no such model"
 * failure pins this fallback for the rest of the session.
 */
const FALLBACK_MODEL = 'gemini-2.5-flash';
let activeModel = GEMINI_MODEL;

const isUnknownModel = (raw: string): boolean =>
  /not found|NOT_FOUND|is not supported|does not exist|unsupported model|invalid model/i.test(raw);

function model(params: Omit<ModelParams, 'model'> = {}): GenerativeModel {
  return getGenerativeModel(
    getAiClient(),
    { model: activeModel, ...params },
    { timeout: REQUEST_TIMEOUT_MS }
  );
}

/** The model id actually in use, after any fallback. */
export const currentModel = (): string => activeModel;

/**
 * Firebase now auto-enforces App Check for AI Logic during the console's guided
 * setup. An app that sends no App Check token then has every Gemini call
 * rejected — and because the rejection fails CORS, the browser reports only
 * "Failed to fetch". Naming the likely cause saves a long hunt.
 */
const APP_CHECK_HINT =
  'App Check is enforced for AI Logic on this project but the app is not sending a token. ' +
  'Set EXPO_PUBLIC_APP_CHECK_SITE_KEY to your reCAPTCHA v3 site key and redeploy, ' +
  'or unenforce App Check for AI Logic in the Firebase console.';

/**
 * App Check started on our side but Google refused the token. The usual cause
 * is a mismatched reCAPTCHA pair — the secret stored in the Firebase console
 * has to belong to the same key as the site key compiled into this build — or
 * a site key whose allowed domains do not include this origin.
 */
const APP_CHECK_TOKEN_REJECTED =
  'App Check started but its token was refused. Check that the reCAPTCHA secret saved in ' +
  'Firebase console > App Check matches this build’s site key, and that the key’s ' +
  'domain list includes this site.';

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
  // Two very different failures both mention App Check, and telling a user to
  // "set the site key" when the key is already set sends them the wrong way.
  if (/app.?check|attestation|unattested/i.test(raw)) {
    return isAppCheckEnabled() ? `${APP_CHECK_TOKEN_REJECTED} (${raw.slice(0, 120)})` : APP_CHECK_HINT;
  }
  if (/permission|403|PERMISSION_DENIED|unauthenticated|401/i.test(raw)) {
    return isAppCheckEnabled()
      ? `${APP_CHECK_TOKEN_REJECTED} (${raw.slice(0, 120)})`
      : `Firebase AI Logic rejected the request. ${APP_CHECK_HINT}`;
  }
  if (/timed? ?out|deadline/i.test(raw)) return 'Gemini took too long to respond. Try again.';
  if (/network|fetch|Failed to fetch|ERR_/i.test(raw)) {
    // A blocked App Check request comes back as an opaque CORS failure, which
    // the browser reports as a plain "Failed to fetch" — indistinguishable
    // from a real outage unless we know whether App Check started.
    return isAppCheckEnabled()
      ? `Could not reach Gemini. ${APP_CHECK_TOKEN_REJECTED}`
      : `Could not reach Gemini. ${APP_CHECK_HINT}`;
  }
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
    .map((source, index) => {
      let body = source.text;
      if (body.length > budgetPerSource) {
        const half = Math.floor(budgetPerSource / 2);
        body = `${body.slice(0, half)}\n\n[... middle of this document omitted for length ...]\n\n${body.slice(-half)}`;
      }
      // Numbered as well as titled: students often have several files with
      // near-identical names, and the index disambiguates a citation.
      return `<source index="${index + 1}" title="${source.title.replace(/"/g, "'")}">\n${body}\n</source>`;
    })
    .join('\n\n');
}

async function generate(params: Omit<ModelParams, 'model'>, prompt: string): Promise<string> {
  try {
    const result = await model(params).generateContent(prompt);
    return result.response.text();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);

    if (isUnknownModel(raw) && activeModel !== FALLBACK_MODEL) {
      console.warn(`[ai] model "${activeModel}" unavailable; falling back to ${FALLBACK_MODEL}`);
      activeModel = FALLBACK_MODEL;
      const retry = await model(params)
        .generateContent(prompt)
        .catch((second) => {
          throw new AiError(describe(second), second);
        });
      return retry.response.text();
    }

    throw new AiError(describe(error), error);
  }
}

/**
 * Runs a JSON-mode prompt and parses it, retrying once if the model returns
 * something unparseable. Long-context calls are slow and occasionally truncate
 * mid-object; a single retry at a lower temperature recovers nearly all of
 * those without making the student start over.
 */
async function generateJson<T>(
  params: Omit<ModelParams, 'model'>,
  prompt: string,
  validate: (value: unknown) => value is T
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const config = {
      ...params,
      generationConfig: {
        ...params.generationConfig,
        // Second pass: clamp creativity so the model follows the schema.
        ...(attempt === 1 ? { temperature: 0 } : {}),
      },
    };

    try {
      const raw = await generate(config, prompt);
      const parsed = parseJson<unknown>(raw);
      if (validate(parsed)) return parsed;
      lastError = new AiError('Gemini returned JSON in an unexpected shape.');
    } catch (error) {
      // A transport or quota failure will not be fixed by retrying the parse.
      if (error instanceof AiError && !/not valid JSON|unexpected shape/i.test(error.message)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AiError('Gemini returned an unusable response.');
}

/**
 * Plain-prose summary using the shared model exported from services/firebase.
 *
 * Used as the fallback when structured extraction fails: a JSON-schema call is
 * strictly harder than free text, so a document that defeats the schema can
 * usually still be summarised. Without this a parse failure left the student
 * with an untitled, unsummarised document.
 */
export async function summarizeDocument(text: string): Promise<string> {
  const prompt =
    `Summarise this study document for a university student in 2-4 sentences. ` +
    `Describe what it teaches, not what kind of document it is. ` +
    `Plain prose, no markdown, no preamble.\n\n${text.slice(0, MAX_CONTEXT_CHARS)}`;

  // getModel() is the shared instance from services/firebase; generate() adds
  // the model fallback and error mapping the rest of the app relies on.
  try {
    const result = await getModel().generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (isUnknownModel(raw)) return (await generate({}, prompt)).trim();
    throw new AiError(describe(error), error);
  }
}

/**
 * Free-form prose generation for callers that supply their own full prompt
 * (see services/aiNotes). Goes through the same model fallback and error
 * mapping as everything else.
 */
export async function generateProse(prompt: string, temperature = 0.4): Promise<string> {
  return generate({ generationConfig: { temperature } }, prompt);
}

/* ------------------------------------------------------------------ *
 * Multimodal input
 * ------------------------------------------------------------------ */

/**
 * Gemini takes binary parts as base64. Chunked so a large file does not blow
 * the call stack the way String.fromCharCode(...bytes) would.
 */
function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function generateFromMedia(
  data: ArrayBuffer,
  mimeType: string,
  prompt: string,
  generationConfig: Record<string, unknown> = {}
): Promise<string> {
  try {
    const result = await model({
      generationConfig: { temperature: 0.1, ...generationConfig },
    }).generateContent([
      { inlineData: { data: toBase64(data), mimeType } },
      { text: prompt },
    ]);
    return result.response.text();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/too large|payload|request entity/i.test(raw)) {
      throw new AiError('That image is too large for a single Gemini request. Crop it and retry.');
    }
    throw new AiError(describe(error), error);
  }
}

/** OCR plus layout reading for an image of notes, slides or a whiteboard. */
export async function readImage(data: ArrayBuffer, mimeType: string): Promise<string> {
  return (
    await generateFromMedia(
      data,
      mimeType,
      `Transcribe every piece of text in this image exactly, preserving reading order.

- Keep the structure: headings stay headings, bullets stay bullets, and tables
  come out as Markdown tables.
- Transcribe formulas in LaTeX between $ delimiters.
- For a diagram or chart, transcribe its labels and then add one line beginning
  "Figure:" describing what it shows.
- Do not summarise, correct or comment. Output the content only.
- If the image contains no text at all, reply with exactly: NO_TEXT_FOUND`
    )
  ).replace(/^NO_TEXT_FOUND$/m, '');
}

/** Transcript plus lecture takeaways for a recording. */
export async function transcribeMedia(
  data: ArrayBuffer,
  mimeType: string,
  kind: 'audio' | 'video'
): Promise<string> {
  return generateFromMedia(
    data,
    mimeType,
    `This is a recorded lecture (${kind}). Produce two sections.

## Transcript
The full spoken content, lightly cleaned: drop filler words and false starts,
keep every substantive sentence. Mark speaker changes as "Speaker 1:" when more
than one voice is present. Insert [mm:ss] timestamps at each topic change.
${kind === 'video' ? 'Include text visible on slides as "[Slide: …]" where it appears.\n' : ''}
## Key Takeaways
The main teaching points as bullets, in the order they were covered, with the
timestamp each begins at. Cover what a student would need for an exam, not the
administrative asides.`
  );
}

/** Today's date, so the model can resolve "week 5" and bare day/month dates. */
function todayContext(): string {
  const now = new Date();
  return `Today is ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString(undefined, {
    weekday: 'long',
  })}).`;
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
          title: Schema.string({ description: 'What is due, e.g. "Problem Set 3".' }),
          dueDate: Schema.string({ description: 'ISO 8601 date (YYYY-MM-DD), or empty if unknown.' }),
          dueTime: Schema.string({ description: '24h HH:MM if a time is stated, else empty.' }),
          kind: Schema.string({
            description: 'One of: assignment, exam, quiz, lab, project, reading, presentation, other.',
          }),
        },
        optionalProperties: ['dueDate', 'dueTime', 'kind'],
      }),
    }),
  },
  optionalProperties: ['moduleCode'],
});

function isMetadata(value: unknown): value is Partial<ExtractedMetadata> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function extractMetadata(text: string): Promise<ExtractedMetadata> {
  const parsed = await generateJson<Partial<ExtractedMetadata>>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: metadataSchema,
        temperature: 0.1,
      },
    },
    `Analyze this syllabus/lecture document and return the requested JSON.

${todayContext()}

Rules:
- "moduleCode": the official course code if one appears (e.g. "MA1521"), else "".
- "subjectName": the subject/course this belongs to, in title case. Never empty — infer it from the content if it is not stated.
- "summary": 2-4 sentences on what this document actually teaches. Describe the content, not the document type.
- "deadlines": every assessment, assignment, exam, lab or submission that has a date.
  · "dueDate" is ISO YYYY-MM-DD.
  · A date with no year belongs to the academic year the document implies. If the
    month is already past relative to today, it almost certainly refers to the
    coming year rather than one that has gone.
  · "dueTime" only when the document states one (e.g. "by 5pm" -> "17:00").
    Leave it empty rather than inventing a time.
  · "kind" classifies it; use "other" when unclear.
  · A recurring item ("weekly quizzes") is not a dated deadline — skip it.
  · Titles must be self-contained: "Essay 1 draft", not "the draft".
  · Return [] when the document has no dated assessments.

DOCUMENT:
${text.slice(0, MAX_CONTEXT_CHARS)}`,
    isMetadata
  );

  return {
    moduleCode: parsed.moduleCode?.trim() || null,
    subjectName: parsed.subjectName?.trim() || null,
    summary: parsed.summary?.trim() || null,
    deadlines: Array.isArray(parsed.deadlines)
      ? parsed.deadlines
          .filter((d) => d && typeof d.title === 'string' && d.title.trim())
          .map((d) => ({
            title: d.title.trim(),
            dueDate: d.dueDate?.trim() || null,
            dueTime: (d as { dueTime?: string }).dueTime?.trim() || null,
            kind: (d as { kind?: string }).kind?.trim() || null,
          }))
      : [],
  };
}

/* ------------------------------------------------------------------ *
 * Task 4 — grounded multi-source chat
 * ------------------------------------------------------------------ */

export const READER_SYSTEM_PROMPT = [
  'You are Notomi, an expert tutor for a university student.',
  '',
  'GROUNDING — this is absolute:',
  '- Answer ONLY from the SOURCES below. They are the student\'s own uploaded material.',
  '- Never use outside knowledge to add facts, even if you are confident they are true.',
  '- If the sources do not answer the question, say exactly what is missing and',
  '  suggest what the student could upload. Do not guess or pad.',
  '- If sources disagree, say so and quote both.',
  '',
  'CITING:',
  '- Support every substantive claim with the exact supporting sentence in double',
  '  quotes, followed by the source title in brackets:',
  '  "photosynthesis converts light energy" [Lecture 3].',
  '- Quote verbatim. Never paraphrase inside quotation marks.',
  '- One or two short quotes per point is plenty; do not wall-of-quote.',
  '',
  'TEACHING:',
  '- Lead with the direct answer, then the support.',
  '- Prefer short paragraphs and bullets over long prose.',
  '- Define jargon the first time it appears.',
  '- When the student asks for revision help, work from what the sources emphasise',
  '  (repetition, worked examples, stated learning outcomes) rather than your own',
  '  sense of what matters.',
  '- Use **bold** for key terms. Never invent page numbers or figures.',
].join('\n');

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
    ? `\n\nThe student previously got these concepts wrong. Weight at least half the questions toward them, approaching each from a different angle than a simple recall check:\n${options.focusConcepts.map((c) => `- ${c}`).join('\n')}`
    : '';

  const parsed = await generateJson<QuizQuestion[]>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: quizSchema,
        temperature: 0.6,
      },
    },
    `Generate a ${count}-question multiple-choice quiz based strictly on the provided text.

Rules:
- Exactly 4 options per question, exactly one unambiguously correct.
- "correctAnswerIndex" is the zero-based index of the correct option.
- Distractors must be plausible: draw them from genuine misconceptions or from
  neighbouring ideas in the same material. Never use joke options, "all of the
  above", or answers that are obviously wrong on length or specificity alone.
- Vary the correct index across the quiz; do not favour any position.
- Mix difficulty: roughly a third recall, a third application, a third analysis.
  Prefer questions that require reasoning over ones answered by matching a
  keyword.
- "explanation": one or two sentences on why the answer is right AND why the
  most tempting distractor is wrong.
- "concept": the specific 2-5 word topic tested.
- Never test document formatting, page numbers, or administrative trivia such as
  the lecturer's email.
- If the text is too thin to support ${count} good questions, return fewer rather
  than padding with weak ones.${focus}

TEXT:
${context}`,
    (value): value is QuizQuestion[] => Array.isArray(value)
  );

  const valid = parsed.filter(
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

/* ------------------------------------------------------------------ *
 * Timetable extraction from a schedule screenshot
 * ------------------------------------------------------------------ */

const timetableSchema = Schema.array({
  items: Schema.object({
    properties: {
      title: Schema.string({ description: 'Course name without the code.' }),
      code: Schema.string({ description: 'Module code such as "CS2040". Empty if absent.' }),
      kind: Schema.string({ description: 'Lecture, Tutorial, Lab, Seminar… or empty.' }),
      day: Schema.string({ description: 'Full weekday name in English, e.g. "Monday".' }),
      start: Schema.string({ description: '24-hour HH:MM.' }),
      end: Schema.string({ description: '24-hour HH:MM.' }),
      venue: Schema.string({ description: 'Room or building. Empty string if absent.' }),
    },
    optionalProperties: ['code', 'kind', 'venue'],
  }),
});

/**
 * Reads a photo or screenshot of a university timetable.
 *
 * Schedules are laid out as grids where the day is a column header and the time
 * a row header, so the cell alone never carries the information — the prompt
 * has to force the model to resolve each block against both axes.
 */
export async function extractTimetable(
  data: ArrayBuffer,
  mimeType: string
): Promise<ExtractedClass[]> {
  const raw = await generateFromMedia(
    data,
    mimeType,
    `This image is a university class timetable. Extract every scheduled class.

DAY
- The day comes from the column or row header the block sits under. Headers
  often carry a date too ("Monday Aug 17") — take the weekday, ignore the date.
- Resolve abbreviations: Mon/M -> Monday, Tue/Tu -> Tuesday, Wed/W -> Wednesday,
  Thu/Th/R -> Thursday, Fri/F -> Friday, Sat -> Saturday, Sun -> Sunday.

TIME
- If the block prints its own times ("8:00 AM-11:00 AM"), use those. They are
  authoritative and override anything you would infer from the grid.
- Only when no times are printed inside the block, read them off the time axis
  the block spans. A block spanning three one-hour rows is one three-hour class,
  never three classes.
- Give times as 24-hour HH:MM. 8:00 AM is 08:00; 1:30 PM is 13:30; 5:00 PM is
  17:00. A timetable running 9-6 is 09:00-18:00, never 09:00-06:00.

IDENTITY
- "code" is the module or course code: letters then digits, such as CS2040,
  CW6123, MA1101R, PU3312. Take it exactly as printed.
- "title" is the course name if one is printed. Many schedules show only a code
  and a session type — in that case leave "title" empty rather than inventing a
  name or repeating the code.
- "kind" is the session type if shown: Lecture, Tutorial, Lab, Seminar,
  Practical, Workshop. Ignore any group or section prefix such as "LD", "LM",
  "C", "G1" — that is not the session type.
- "venue" is the room, hall or lab, with the label stripped: "Room: CQCR2003-FCI
  Classroom" becomes "CQCR2003-FCI Classroom". Empty if not shown.

ROWS
- One entry per occurrence. A course meeting Monday and Thursday is two entries.
- The same course can appear several times on one day at different hours; each
  is its own entry.
- Ignore breaks, lunch, empty cells, filter controls and legend text.

Return every class you can read. Return an empty array only if the image
contains no schedule at all.`,
    { responseMimeType: 'application/json', responseSchema: timetableSchema }
  );

  const parsed = parseJson<ExtractedClass[]>(raw);
  if (!Array.isArray(parsed)) {
    throw new AiError('Gemini could not read a timetable from that image.');
  }

  // A row needs a day, a start and an end. It does NOT need a title: plenty of
  // schedules print only a code and a session type, and demanding a course name
  // silently dropped every class on those.
  return parsed
    .filter(
      (entry) =>
        entry &&
        typeof entry.day === 'string' &&
        entry.day.trim() &&
        typeof entry.start === 'string' &&
        typeof entry.end === 'string' &&
        ((entry.title ?? '').trim() || (entry.code ?? '').trim())
    )
    .map((entry) => ({
      title: (entry.title ?? '').trim(),
      code: (entry.code ?? '').trim() || null,
      kind: (entry.kind ?? '').trim() || null,
      day: entry.day.trim(),
      start: entry.start.trim(),
      end: entry.end.trim(),
      venue: (entry.venue ?? '').trim() || null,
    }));
}

/* ------------------------------------------------------------------ *
 * Flashcards
 * ------------------------------------------------------------------ */

const flashcardSchema = Schema.array({
  items: Schema.object({
    properties: {
      front: Schema.string({ description: 'The prompt side: a question or a term.' }),
      back: Schema.string({ description: 'The answer side.' }),
      concept: Schema.string({ description: '2-5 word topic label.' }),
    },
    optionalProperties: ['concept'],
  }),
});

export async function generateFlashcards(
  context: string,
  count = 20
): Promise<GeneratedCard[]> {
  const parsed = await generateJson<GeneratedCard[]>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: flashcardSchema,
        temperature: 0.5,
      },
    },
    `Write ${count} flashcards from the material below.

- One idea per card. A card testing two things is two cards.
- "front" is a question or a term — never a statement with the answer in it.
- "back" is the complete answer in one to three sentences. It must stand alone:
  a student reading only the back should understand it.
- Cover definitions, mechanisms, distinctions between similar ideas, and the
  conditions under which something applies. Skip administrative trivia.
- Where the material has a formula, make a card asking what each symbol means.
- Never write a card whose answer is "yes" or "no".
- If the material is thin, return fewer good cards rather than padding.

MATERIAL:
${context}`,
    (value): value is GeneratedCard[] => Array.isArray(value)
  );

  const valid = parsed.filter(
    (card) => card && typeof card.front === 'string' && card.front.trim() && card.back?.trim()
  );
  if (valid.length === 0) throw new AiError('Gemini did not return any usable flashcards.');
  return valid.map((card) => ({
    front: card.front.trim(),
    back: card.back.trim(),
    concept: card.concept?.trim() || null,
  }));
}

/* ------------------------------------------------------------------ *
 * Open questions: Socratic tutor and exam simulator
 * ------------------------------------------------------------------ */

const openQuestionSchema = Schema.array({
  items: Schema.object({
    properties: {
      question: Schema.string(),
      modelAnswer: Schema.string({ description: 'What a full-mark answer contains.' }),
      concept: Schema.string({ description: '2-5 word topic label.' }),
    },
    optionalProperties: ['concept'],
  }),
});

export async function generateOpenQuestions(
  context: string,
  options: { count?: number; style?: 'socratic' | 'exam' } = {}
): Promise<OpenQuestion[]> {
  const count = options.count ?? 6;
  const style = options.style ?? 'exam';

  const brief =
    style === 'socratic'
      ? `Write ${count} questions that make a student explain their understanding out
loud. Favour "why", "how" and "what would happen if" over "what is". Order them
so each one builds on the ground the previous one covered.`
      : `Write ${count} short-answer exam questions of the kind that actually appear on
a paper for this material. Mix definition, application and analysis, and use
command words a marker would use: define, explain, compare, derive, justify.`;

  const parsed = await generateJson<OpenQuestion[]>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: openQuestionSchema,
        temperature: 0.6,
      },
    },
    `${brief}

- Every question must be answerable from the material alone.
- "modelAnswer" is the marking guide: the specific points a full-mark answer
  must contain, written out. It is never shown before the student answers, so
  write it for a marker, not as a hint.
- "concept" is the 2-5 word topic being tested.

MATERIAL:
${context}`,
    (value): value is OpenQuestion[] => Array.isArray(value)
  );

  const valid = parsed.filter(
    (entry) => entry && typeof entry.question === 'string' && entry.question.trim()
  );
  if (valid.length === 0) throw new AiError('Gemini did not return any usable questions.');
  return valid.map((entry) => ({
    question: entry.question.trim(),
    modelAnswer: entry.modelAnswer?.trim() || '',
    concept: entry.concept?.trim() || null,
  }));
}

const gradeSchema = Schema.object({
  properties: {
    score: Schema.number({ description: '0-100. Partial credit is expected.' }),
    verdict: Schema.string({ description: 'One short sentence of overall judgement.' }),
    whatWentWell: Schema.string(),
    whatWasMissing: Schema.string(),
    followUp: Schema.string({ description: 'Next question, or empty to end.' }),
  },
  optionalProperties: ['followUp'],
});

/**
 * Marks a free-text answer against the question's own marking guide.
 *
 * The guide is passed in rather than re-derived so the tutor cannot move the
 * goalposts between asking and marking.
 */
export async function gradeAnswer(
  context: string,
  question: OpenQuestion,
  answer: string,
  options: { socratic?: boolean } = {}
): Promise<AnswerGrade> {
  const parsed = await generateJson<AnswerGrade>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: gradeSchema,
        temperature: 0.2,
      },
    },
    `You are marking a university student's answer.

QUESTION
${question.question}

MARKING GUIDE (what a full-mark answer contains)
${question.modelAnswer || 'Judge against the source material below.'}

STUDENT'S ANSWER
${answer}

Mark it:
- "score" 0-100 against the guide. Award partial credit generously for correct
  reasoning expressed imprecisely; do not deduct for phrasing, spelling or
  brevity if the substance is right. A blank or off-topic answer scores 0.
- "verdict": one sentence a student can act on.
- "whatWentWell": the specific things they got right. If nothing, say so plainly.
- "whatWasMissing": the specific points from the guide they did not reach, and
  the correction for anything they stated wrongly. Teach here — explain the
  missing idea rather than just naming it.
${
  options.socratic
    ? `- "followUp": one question that pushes their understanding one step further —
  probing a gap if they missed something, or extending to a harder case if they
  did well. Leave empty only if the topic is genuinely exhausted.`
    : `- "followUp": leave empty.`
}
- Never invent facts that are not in the source material below.

SOURCE MATERIAL
${context.slice(0, 120_000)}`,
    (value): value is AnswerGrade => !!value && typeof (value as AnswerGrade).score === 'number'
  );

  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    verdict: parsed.verdict?.trim() || '',
    whatWentWell: parsed.whatWentWell?.trim() || '',
    whatWasMissing: parsed.whatWasMissing?.trim() || '',
    followUp: parsed.followUp?.trim() || null,
  };
}
