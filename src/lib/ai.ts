import {
  getGenerativeModel,
  Schema,
  type GenerativeModel,
  type ModelParams,
} from 'firebase/ai';
import { GEMINI_MODEL, getAiClient, getModel, isAppCheckEnabled } from '@/services/firebase';
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
  prompt: string
): Promise<string> {
  try {
    const result = await model({ generationConfig: { temperature: 0.1 } }).generateContent([
      { inlineData: { data: toBase64(data), mimeType } },
      { text: prompt },
    ]);
    return result.response.text();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/too large|payload|request entity/i.test(raw)) {
      throw new AiError('That file is too large for a single Gemini request. Split it and retry.');
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
