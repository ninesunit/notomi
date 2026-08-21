import {
  getGenerativeModel,
  ThinkingLevel,
  Schema,
  type Content,
  type FunctionDeclarationsTool,
  type GenerativeModel,
  type ModelParams,
  type Part,
} from 'firebase/ai';
import { withAiResponseCache } from './aiCache';
import { GEMINI_MODEL, getAiClient, isAppCheckEnabled } from '@/services/firebase';
import type {
  AnswerGrade,
  AssignmentBreakdown,
  ExtractedAcademicTerm,
  ExtractedClass,
  ExtractedMetadata,
  GeneratedCard,
  LectureRundown,
  OpenQuestion,
  PodcastLine,
  QuizQuestion,
  RevisionPlanItem,
} from './schema';

/**
 * Gemini's context window is well over a million tokens, so Notomi skips RAG
 * entirely: the whole corpus for a subject is pasted into the prompt. This cap
 * exists only to stay inside the window and keep latency sane on a phone.
 * Roughly four characters per token; 3M characters leaves substantial room
 * for system instructions, the rolling conversation, and model output.
 */
export const MAX_CONTEXT_CHARS = 3_000_000;

export class AiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
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
 * Keep current stable models from separate quota pools available. A project
 * can exhaust one model's RPM/RPD allowance while another model is still
 * healthy, and model retirement should not take every AI surface down at once.
 */
const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'] as const;
const MODEL_POOL: readonly string[] = [GEMINI_MODEL, ...FALLBACK_MODELS];
const ACTIVE_MODEL_KEY = 'notomi:active-ai-model';
const MODEL_COOLDOWN_KEY = 'notomi:ai-model-cooldowns-v1';

function rememberedModel(): string {
  if (typeof sessionStorage === 'undefined') return GEMINI_MODEL;
  try {
    const value = sessionStorage.getItem(ACTIVE_MODEL_KEY);
    return value && MODEL_POOL.includes(value) ? value : GEMINI_MODEL;
  } catch {
    return GEMINI_MODEL;
  }
}

let activeModel = rememberedModel();

function rememberModel(modelName: string): void {
  activeModel = modelName;
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(ACTIVE_MODEL_KEY, modelName);
  } catch {
    /* Private browsing can reject storage; the in-memory fallback still works. */
  }
}

function modelCooldowns(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_COOLDOWN_KEY) ?? '{}') as Record<string, unknown>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > now
      )
    );
  } catch {
    return {};
  }
}

function saveModelCooldowns(cooldowns: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(MODEL_COOLDOWN_KEY, JSON.stringify(cooldowns));
  } catch {
    /* Private browsing can reject storage; this is only a quota guard. */
  }
}

function retryDelayMs(error: unknown): number {
  const raw = errorDetails(error).message;
  const seconds =
    /retryDelay(?:\\?"|\s|:)+(\d+)s/i.exec(raw)?.[1] ??
    /try again in\s+(\d+(?:\.\d+)?)s/i.exec(raw)?.[1];
  return Math.max(30_000, Math.min(10 * 60_000, Math.ceil(Number(seconds) || 60) * 1000));
}

function coolDownModel(modelName: string, error: unknown): void {
  const cooldowns = modelCooldowns();
  cooldowns[modelName] = Date.now() + retryDelayMs(error);
  saveModelCooldowns(cooldowns);
}

function clearModelCooldown(modelName: string): void {
  const cooldowns = modelCooldowns();
  if (!(modelName in cooldowns)) return;
  delete cooldowns[modelName];
  saveModelCooldowns(cooldowns);
}

const isUnknownModel = (raw: string): boolean =>
  /not found|NOT_FOUND|is not supported|does not exist|unsupported model|invalid model/i.test(raw);

/**
 * Thinking off, for the calls where it buys nothing.
 *
 * Recent models reason before answering, which is worth the wait for a quiz or
 * a set of notes and is pure latency for "where is my next class" or for
 * pulling a module code out of a syllabus. Those calls are short, structured
 * and judged on speed, so they opt out; the heavy generative ones say nothing
 * and keep the model's default.
 */
const FAST_THINKING = { thinkingLevel: ThinkingLevel.MINIMAL } as const;

/**
 * Not every model accepts a thinking budget, and one that does not errors the
 * whole request rather than ignoring the field — so sending it unconditionally
 * would be a way to take every AI feature down again. The first refusal turns
 * it off for the session and the call is retried without it, which means the
 * worst case is one wasted round trip once, not a broken app.
 */
const THINKING_UNSUPPORTED_KEY = 'notomi:ai-thinking-unsupported-v2';
let thinkingRejected = false;

function thinkingIsRejected(): boolean {
  if (thinkingRejected) return true;
  if (typeof localStorage === 'undefined') return false;
  try {
    thinkingRejected = localStorage.getItem(THINKING_UNSUPPORTED_KEY) === '1';
  } catch {
    /* private mode; in-memory only */
  }
  return thinkingRejected;
}

function rememberThinkingRejected(): void {
  thinkingRejected = true;
  console.info('[ai] this model refused a thinking budget; continuing without one.');
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(THINKING_UNSUPPORTED_KEY, '1');
  } catch {
    /* private mode; in-memory only */
  }
}

/**
 * Any 400 raised while we are attaching a thinking setting.
 *
 * This deliberately does not look at the message. The first version matched
 * /thinking/i and never fired once, because the model answers a thinking
 * setting it does not support with a bare "Request contains an invalid
 * argument" that names no field at all — so the safety net that was supposed
 * to make this change unbreakable was itself the thing that broke it.
 *
 * Over-matching is the safe direction. A 400 from some other cause costs one
 * retry and then surfaces normally; a 400 we fail to catch takes every AI
 * feature down.
 */
function isThinkingRefusal(error: unknown): boolean {
  return errorDetails(error).httpStatus === 400;
}

const sendsThinking = (params: Omit<ModelParams, 'model'>): boolean =>
  Boolean(params.generationConfig?.thinkingConfig);

/** The same params with the thinking budget removed, leaving the rest intact. */
function withoutThinking(params: Omit<ModelParams, 'model'>): Omit<ModelParams, 'model'> {
  if (!sendsThinking(params)) return params;
  const { thinkingConfig: _dropped, ...generationConfig } = params.generationConfig ?? {};
  return { ...params, generationConfig };
}

function modelFor(modelName: string, params: Omit<ModelParams, 'model'> = {}): GenerativeModel {
  const tuned = thinkingIsRejected() ? withoutThinking(params) : params;
  return getGenerativeModel(
    getAiClient(),
    { model: modelName, ...tuned },
    { timeout: REQUEST_TIMEOUT_MS }
  );
}

/** The model id actually in use, after any fallback. */
export const currentModel = (): string => activeModel;

type SdkErrorShape = {
  name?: string;
  code?: string;
  message?: string;
  cause?: unknown;
  customData?: { httpStatus?: number; status?: number; statusText?: string };
  customErrorData?: { status?: number; statusText?: string };
};

/** Finds Firebase's HTTP metadata even when it is wrapped by Notomi's AiError. */
function errorDetails(error: unknown): {
  name: string | null;
  code: string | null;
  message: string;
  httpStatus: number | null;
  statusText: string | null;
} {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let fallback: SdkErrorShape = {};

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const detail = current as SdkErrorShape;
    fallback = detail;
    const status =
      detail.customErrorData?.status ?? detail.customData?.httpStatus ?? detail.customData?.status;
    if (typeof status === 'number') {
      return {
        name: detail.name ?? null,
        code: detail.code ?? null,
        message: detail.message ?? String(error),
        httpStatus: status,
        statusText: detail.customErrorData?.statusText ?? detail.customData?.statusText ?? null,
      };
    }
    current = detail.cause;
  }

  return {
    name: fallback.name ?? (error instanceof Error ? error.name : null),
    code: fallback.code ?? null,
    message: fallback.message ?? (error instanceof Error ? error.message : String(error)),
    httpStatus: null,
    statusText: null,
  };
}

/** Detailed deploy diagnostics; prompts and student data are deliberately absent. */
function logAiFailure(operation: string, error: unknown, modelName = activeModel): void {
  const detail = errorDetails(error);
  // A single serialized line survives browser log collectors which otherwise
  // collapse the useful object to the word "Object".
  console.error(
    `[ai] ${operation} failed: ${JSON.stringify({
      model: modelName,
      appCheckEnabled: isAppCheckEnabled(),
      online: typeof navigator === 'undefined' ? null : navigator.onLine,
      ...detail,
    })}`
  );
}

function canTryAnotherModel(error: unknown): boolean {
  const { httpStatus, message } = errorDetails(error);
  return (
    httpStatus === 404 ||
    httpStatus === 429 ||
    httpStatus === 503 ||
    isUnknownModel(message) ||
    /quota|RESOURCE_EXHAUSTED|rate.?limit|model.*overloaded|UNAVAILABLE/i.test(message)
  );
}

/** Runs one request through the active model and current stable fallbacks. */
async function runWithModelFallback<T>(
  operation: string,
  params: Omit<ModelParams, 'model'>,
  run: (candidate: GenerativeModel) => Promise<T>
): Promise<T> {
  const cooldowns = modelCooldowns();
  const completePool = [...new Set([activeModel, ...MODEL_POOL])];
  const candidates = completePool.filter((candidate) => !cooldowns[candidate]);
  if (candidates.length === 0) {
    const retryAt = Math.min(...Object.values(cooldowns));
    const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    throw new AiError(`The free AI allowance is cooling down. Try again in ${seconds} seconds.`);
  }
  let lastError: unknown;

  // Timed because "the AI is slow" is not a diagnosis. Which call, on which
  // model, for how many milliseconds is one — and it is the difference
  // between fixing the slow thing and tuning the fast one.
  const startedAt = Date.now();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      let value: T;
      try {
        value = await run(modelFor(candidate, params));
      } catch (error) {
        // A model with no thinking setting refuses the request outright rather
        // than ignoring the field. That is a fault in our config, not in this
        // model, so drop the budget for the session and give the same
        // candidate another go — spending a fallback on it would blame the
        // wrong thing and still fail on the next model for the same reason.
        if (isThinkingRefusal(error) && sendsThinking(params) && !thinkingIsRejected()) {
          // Retry with the setting explicitly stripped, and only conclude it
          // was to blame if that actually succeeds. Recording it up front
          // would let any unrelated 400 — a malformed prompt, a bad schema —
          // switch the optimisation off for good on a single false positive.
          value = await run(modelFor(candidate, withoutThinking(params)));
          rememberThinkingRejected();
        } else {
          throw error;
        }
      }
      clearModelCooldown(candidate);
      console.info(`[ai] ${operation} · ${candidate} · ${Date.now() - startedAt}ms`);
      if (candidate !== activeModel) {
        console.info(`[ai] switched from ${activeModel} to ${candidate}.`);
        rememberModel(candidate);
      }
      return value;
    } catch (error) {
      lastError = error;
      logAiFailure(operation, error, candidate);
      if (errorDetails(error).httpStatus === 429 || /quota|RESOURCE_EXHAUSTED/i.test(errorDetails(error).message)) {
        coolDownModel(candidate, error);
      }
      if (!canTryAnotherModel(error) || index === candidates.length - 1) throw error;
      console.warn(`[ai] ${candidate} is unavailable; trying ${candidates[index + 1]}.`);
    }
  }

  throw lastError;
}

/**
 * The diagnostic, for whoever deployed this — not for the student.
 *
 * Attestation is enforced for the AI service during its guided setup, and an
 * app that sends no token has every call rejected. Because the rejection fails
 * CORS, the browser reports only "Failed to fetch", which is indistinguishable
 * from an outage. That is worth logging in detail; it is not worth putting on
 * screen, where it would name the whole stack to anyone who hit a hiccup.
 */
function logSetupHint(kind: 'missing-token' | 'token-refused', raw: string): void {
  console.warn(
    `[ai] ${
      kind === 'missing-token'
        ? 'attestation is enforced but this build sends no token — set the App Check site key'
        : 'the attestation token was refused — check the site key and its allowed domains'
    }: ${raw.slice(0, 200)}`
  );
}

/**
 * Shown when the request never reaches the AI. Nothing the student can do
 * changes it, so it does not ask them to try anything — it says whose problem
 * it is and that it is being worked on.
 */
const AI_UNREACHABLE =
  "Notomi's AI is temporarily unavailable. This is a problem on our side, not with your device — your work is safe and it should be back shortly.";

/** Turns an unknown SDK failure into something worth showing a student. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const { httpStatus } = errorDetails(error);

  if (/API key not valid/i.test(raw)) {
    console.warn(`[ai] the API key was rejected: ${raw.slice(0, 200)}`);
    return 'This app is not configured correctly yet.';
  }
  if (/AI Logic|not enabled|SERVICE_DISABLED|has not been used/i.test(raw)) {
    console.warn(`[ai] the AI service is not enabled for this project: ${raw.slice(0, 200)}`);
    return 'The AI features are not switched on for this app yet.';
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return 'Too many AI requests just now. Wait a moment and try again.';
  }
  if (httpStatus === 400) {
    return 'The AI service could not process that request. Try asking in a different way.';
  }

  // Two very different failures both mention attestation, and they need
  // different fixes — but both read the same to a student.
  //
  // The wording matters. This said "not available on this device", which sends
  // students off reinstalling, clearing storage and switching browsers over a
  // fault that is entirely on our side and identical on every device. Say that
  // it is ours and that waiting is the right move, because it is.
  if (/app.?check|attestation|unattested/i.test(raw)) {
    logSetupHint(isAppCheckEnabled() ? 'token-refused' : 'missing-token', raw);
    return AI_UNREACHABLE;
  }
  if (/permission|403|PERMISSION_DENIED|unauthenticated|401/i.test(raw)) {
    logSetupHint(isAppCheckEnabled() ? 'token-refused' : 'missing-token', raw);
    return AI_UNREACHABLE;
  }

  if (/timed? ?out|deadline/i.test(raw)) return 'That took too long to come back. Try again.';
  if (/network|fetch|Failed to fetch|ERR_/i.test(raw)) {
    return 'Could not reach the AI service. Check your connection and try again.';
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
    throw new AiError('The response came back in a shape Notomi could not read.');
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
    return await withAiResponseCache(
      {
        namespace: 'text',
        payload: JSON.stringify({ models: MODEL_POOL, params, prompt }),
      },
      async () => {
        const result = await runWithModelFallback('generateContent', params, (candidate) =>
          candidate.generateContent(prompt)
        );
        return result.response.text();
      }
    );
  } catch (error) {
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
      lastError = new AiError('The response came back in a shape Notomi could not read.');
    } catch (error) {
      // A transport or quota failure will not be fixed by retrying the parse.
      if (
        error instanceof AiError &&
        !/not valid JSON|unexpected shape|shape Notomi could not read/i.test(error.message)
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new AiError('The response could not be used.');
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

  return (await generate({}, prompt)).trim();
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
    return await withAiResponseCache(
      {
        namespace: 'media',
        payload: JSON.stringify({ models: MODEL_POOL, mimeType, generationConfig, prompt }),
        bytes: data,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      },
      async () => {
        const result = await runWithModelFallback(
          'generateFromMedia',
          { generationConfig: { temperature: 0.1, ...generationConfig } },
          (candidate) =>
            candidate.generateContent([
              { inlineData: { data: toBase64(data), mimeType } },
              { text: prompt },
            ])
        );
        return result.response.text();
      }
    );
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/too large|payload|request entity/i.test(raw)) {
      throw new AiError(
        'That file is too large to send in one request. Compress or split it and retry.'
      );
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
    documentType: Schema.string({
      description:
        'Exactly one of TimetableSchedule, AcademicCalendar, SubjectMaterial, GeneralNote.',
    }),
    moduleCode: Schema.string({
      description: 'Course/module code such as "CS3243". Empty string if absent.',
    }),
    subjectName: Schema.string({ description: 'Human readable subject name.' }),
    summary: Schema.string({
      description: '2-4 sentence summary of the document.',
    }),
    deadlines: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string({
            description: 'What is due, e.g. "Problem Set 3".',
          }),
          dueDate: Schema.string({
            description: 'ISO 8601 date (YYYY-MM-DD), or empty if unknown.',
          }),
          dueTime: Schema.string({
            description: '24h HH:MM if a time is stated, else empty.',
          }),
          kind: Schema.string({
            description:
              'One of: assignment, exam, quiz, lab, project, reading, presentation, other.',
          }),
          milestones: Schema.array({
            items: Schema.object({
              properties: {
                title: Schema.string({
                  description: 'One concrete work milestone.',
                }),
                weeksBeforeDue: Schema.number({
                  description: 'Whole weeks before the parent due date, from 1 to 8.',
                }),
              },
            }),
          }),
        },
        optionalProperties: ['dueDate', 'dueTime', 'kind', 'milestones'],
      }),
    }),
  },
  optionalProperties: ['moduleCode'],
});

function isMetadata(value: unknown): value is Partial<ExtractedMetadata> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const slideSummarySchema = Schema.object({
  properties: {
    headline: Schema.string({
      description: 'At most 8 words naming what this slide is about.',
    }),
    points: Schema.array({
      items: Schema.string({ description: 'One complete thought, under 90 characters.' }),
      description: '2 to 4 points drawn only from the slide text.',
    }),
  },
});

/**
 * A margin note for one slide.
 *
 * Sized for the canvas, not for a document: this lands beside the slide it
 * describes, at a width a student reads at a glance while annotating. Long
 * prose here would be a worse version of the notes generator that already
 * exists — the job is the three or four things this particular slide says.
 */
export async function summariseSlide(
  slideText: string,
  slideTitle: string
): Promise<{ headline: string; points: string[] }> {
  const parsed = await generateJson<{ headline?: string; points?: string[] }>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: slideSummarySchema,
        temperature: 0.2,
        // Sits directly in front of a student who is mid-annotation and
        // watching the canvas. Speed is the feature.
        thinkingConfig: FAST_THINKING,
      },
    },
    `Summarise this single lecture slide for a student's margin note.

Rules:
- "headline": at most 8 words, naming what this slide is actually about.
- "points": 2 to 4 entries, each a complete thought under 90 characters.
- Only what is on the slide. Do not add context, examples or definitions that
  are not in the text — an invented fact in a study note is worse than a thin
  one, because it will be revised from.
- If the slide is a title, agenda or divider with no substance, say so in the
  headline and return a single point explaining there is nothing to summarise.
- No markdown, no bullet characters, no emojis.

Slide: ${slideTitle}

${slideText.slice(0, 12_000)}`,
    (value): value is { headline?: string; points?: string[] } =>
      typeof value === 'object' && value !== null
  );

  const points = (parsed.points ?? [])
    .map((point) => String(point).replace(/^[-•*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);

  return {
    headline: (parsed.headline ?? slideTitle).trim().slice(0, 80),
    points: points.length > 0 ? points : ['This slide has no text to summarise.'],
  };
}

export async function extractMetadata(text: string): Promise<ExtractedMetadata> {
  const parsed = await generateJson<Partial<ExtractedMetadata>>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: metadataSchema,
        temperature: 0.1,
        // Pulling a title, a module code and some dates out of a document is
        // reading, not reasoning, and this call sits directly in the upload
        // path where every second is one the student spends watching a bar.
        thinkingConfig: FAST_THINKING,
      },
    },
    `Analyze this syllabus/lecture document and return the requested JSON.

${todayContext()}

Rules:
- "documentType": classify the complete file as exactly one of:
  "TimetableSchedule" for weekly class grids or schedules;
  "AcademicCalendar" for institution term dates, study leave or examination windows;
  "SubjectMaterial" for syllabuses, course outlines, lecture slides and subject notes;
  "GeneralNote" for useful notes that do not belong to a named course.
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
  · For a large assignment, project or presentation, add 3-6 "milestones" that
    decompile it into realistic weekly work packets. "weeksBeforeDue" is a whole
    number from 1-8. Do not add milestones for exams, quizzes, readings or labs.
  · A recurring item ("weekly quizzes") is not a dated deadline — skip it.
  · Titles must be self-contained: "Essay 1 draft", not "the draft".
  · Return [] when the document has no dated assessments.

DOCUMENT:
${text.slice(0, MAX_CONTEXT_CHARS)}`,
    isMetadata
  );

  return {
    documentType: normaliseDocumentType(parsed.documentType),
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
            milestones: Array.isArray(d.milestones)
              ? d.milestones
                  .filter(
                    (milestone) =>
                      milestone &&
                      typeof milestone.title === 'string' &&
                      milestone.title.trim() &&
                      Number.isFinite(milestone.weeksBeforeDue)
                  )
                  .map((milestone) => ({
                    title: milestone.title.trim(),
                    weeksBeforeDue: Math.max(1, Math.min(8, Math.round(milestone.weeksBeforeDue))),
                  }))
              : [],
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
  "- Answer ONLY from the SOURCES below. They are the student's own uploaded material.",
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
  const params: Omit<ModelParams, 'model'> = {
    systemInstruction: `${READER_SYSTEM_PROMPT}\n\nSOURCES:\n${context}`,
    generationConfig: { temperature: 0.3 },
  };
  const contents: Content[] = [
    ...history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
    { role: 'user', parts: [{ text: question }] },
  ];

  try {
    return await withAiResponseCache(
      {
        namespace: 'reader-question',
        payload: JSON.stringify({ models: MODEL_POOL, params, contents }),
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      },
      async () => {
        const result = await runWithModelFallback('askSources', params, (candidate) =>
          candidate.generateContent({ contents })
        );
        return result.response.text();
      }
    );
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
    throw new AiError('No audio overview could be written from this material.');
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
      correctAnswerIndex: Schema.number({
        description: 'Zero-based index into options.',
      }),
      explanation: Schema.string(),
      concept: Schema.string({
        description: 'The 2-5 word concept being tested.',
      }),
    },
    optionalProperties: ['concept'],
  }),
});

export async function generateQuiz(
  context: string,
  options: { count?: number; focusConcepts?: string[]; battle?: boolean } = {}
): Promise<QuizQuestion[]> {
  const count = options.count ?? 10;
  const focus = options.focusConcepts?.length
    ? `\n\nThe student previously got these concepts wrong. Weight at least half the questions toward them, approaching each from a different angle than a simple recall check:\n${options.focusConcepts.map((c) => `- ${c}`).join('\n')}`
    : '';
  const battle = options.battle
    ? '\n- Use a standardized university quiz-battle difficulty: direct wording, one inferential step at most, and no question that depends on remembering an isolated number. This profile must stay comparable across unrelated courses.'
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
  than padding with weak ones.${battle}${focus}

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

  if (valid.length === 0) throw new AiError('No usable questions came back from this material.');
  return valid.map((q) => ({ ...q, explanation: q.explanation || '' }));
}

export async function generateBattleCommentary(input: {
  round: number;
  players: { name: string; score: number; streak: number; correct: boolean | null }[];
}): Promise<string> {
  return (
    await generateProse(
      `You are the live host of a university quiz battle. Write one energetic sentence about the round below. Use player names and scores, stay respectful, do not reveal an answer, and do not use emojis.\n\n${JSON.stringify(input)}`,
      0.7
    )
  )
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .trim();
}

const sprintPlanSchema = Schema.array({
  items: Schema.object({
    properties: {
      title: Schema.string(),
      detail: Schema.string(),
      assigneeId: Schema.string(),
      estimatedHours: Schema.number(),
    },
  }),
});

export type GeneratedSprintTask = {
  title: string;
  detail: string;
  assigneeId: string;
  estimatedHours: number;
};

export async function generateSprintPlan(input: {
  guidelines: string;
  members: { id: string; name: string; freeHours: number }[];
}): Promise<GeneratedSprintTask[]> {
  const result = await generateJson<GeneratedSprintTask[]>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: sprintPlanSchema,
        temperature: 0.2,
      },
    },
    `Split these group-project guidelines into 5-12 concrete, equally demanding sub-milestones.
Assign every task to one supplied member id. Balance total estimated hours first, then prefer members with more freeHours. Include research, drafting, integration, checking, and submission where supported. Do not invent deliverables. Every task needs a self-contained title and actionable detail.

MEMBERS:
${JSON.stringify(input.members)}

GUIDELINES:
${input.guidelines.slice(0, MAX_CONTEXT_CHARS)}`,
    (value): value is GeneratedSprintTask[] => Array.isArray(value)
  );

  const memberIds = new Set(input.members.map((member) => member.id));
  return result
    .filter((task) => task?.title?.trim() && memberIds.has(task.assigneeId))
    .map((task) => ({
      title: task.title.trim(),
      detail: task.detail?.trim() || '',
      assigneeId: task.assigneeId,
      estimatedHours: Math.max(0.5, Math.min(40, Number(task.estimatedHours) || 1)),
    }));
}

export async function generateChatStudyGuide(input: {
  subjectName: string;
  sourceSummary: string;
  messages: ChatTurn[];
}): Promise<string> {
  return (
    await generateProse(
      `Create a concise two-page study guide in clean GitHub-flavoured Markdown from this grounded Reader conversation.
Use this exact structure: title, Core Ideas, Important Details, Worked Reasoning, Common Mistakes, and Self-Test.
Do not add facts that are absent from the source summary or conversation. Do not use emojis. Return Markdown only.

SUBJECT: ${input.subjectName}

SOURCE SUMMARY:
${input.sourceSummary.slice(0, 120_000)}

LAST CONVERSATION TURNS:
${input.messages
  .slice(-20)
  .map((message) => `${message.role === 'user' ? 'Student' : 'Notomi'}: ${message.text}`)
  .join('\n\n')}`,
      0.25
    )
  ).trim();
}

/* ------------------------------------------------------------------ *
 * Timetable extraction from a schedule screenshot
 * ------------------------------------------------------------------ */

const timetableSchema = Schema.array({
  items: Schema.object({
    properties: {
      title: Schema.string({ description: 'Course name without the code.' }),
      code: Schema.string({
        description: 'Module code such as "CS2040". Empty if absent.',
      }),
      section: Schema.string({
        description: 'Section/session id for this block, such as "TC1L" or "G3". Empty if absent.',
      }),
      kind: Schema.string({
        description: 'Lecture, Tutorial, Lab, Seminar… or empty.',
      }),
      day: Schema.string({
        description: 'Full weekday name in English, e.g. "Monday".',
      }),
      start: Schema.string({ description: '24-hour HH:MM.' }),
      end: Schema.string({ description: '24-hour HH:MM.' }),
      venue: Schema.string({
        description: 'Room or building. Empty string if absent.',
      }),
    },
    optionalProperties: ['code', 'section', 'kind', 'venue'],
  }),
});

/**
 * Reads a photo or screenshot of a university timetable.
 *
 * Schedules are laid out as grids where the day is a column header and the time
 * a row header, so the cell alone never carries the information — the prompt
 * has to force the model to resolve each block against both axes.
 */
const TIMETABLE_PROMPT = `This document contains a class schedule or timetable. Extract every scheduled class.

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
- "code" is the complete module or course code and nothing else: letters then
  three or more digits, such as CS2040, CPT6123, LDCW6123, LMPU3312 or MA1101R.
  Take every character exactly as printed. Look closely at the left edge and
  never drop leading letters from a code.
- Some registrar printouts visually split the alphabetic prefix into adjacent
  chunks before the digits. Join every adjacent letter chunk that belongs to
  the heading before returning the code: "C PT6123" is CPT6123, "LD CW6123"
  is LDCW6123 and "LM PU3312" is LMPU3312. This is a general typography rule,
  not an institution-specific course list.
- "section" is the section or session identifier printed beside the code, such
  as TC1L, TC2L, TL1L, TL2L, G1, L2, S3. It has one or two digits. It is NOT
  part of the code.

  This distinction matters more than any other on this page. One course runs
  several sessions a week with different section ids — LDCW6123 TC1L and
  LDCW6123 TL1L are the SAME course, two of its sessions. Never fold the
  section into "code", and never treat two sections of one course as two
  courses.
- "title" is the complete course name if one is printed. Never abbreviate or
  truncate a printed name. Many schedules show only a code
  and a session type — in that case leave "title" empty rather than inventing a
  name or repeating the code.
- "kind" is the session type if shown: Lecture, Tutorial, Lab, Seminar,
  Practical, Workshop. Where the schedule prints only a section id, infer it
  where the pattern is obvious across the timetable and leave it empty
  otherwise.
- "venue" is the room, hall or lab, with the label stripped: "Room: CQCR2003-FCI
  Classroom" becomes "CQCR2003-FCI Classroom". Empty if not shown.

ROWS
- One entry per occurrence. A course meeting Monday and Thursday is two entries.
- The same course can appear several times on one day at different hours; each
  is its own entry.
- Ignore breaks, lunch, empty cells, filter controls and legend text.

Return every class you can read. Return an empty array only if the document
contains no schedule at all.`;

function normaliseExtractedClasses(raw: string): ExtractedClass[] {
  const parsed = parseJson<ExtractedClass[]>(raw);
  if (!Array.isArray(parsed)) {
    throw new AiError('No timetable could be read from that file.');
  }

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
      section: (entry.section ?? '').trim() || null,
      kind: (entry.kind ?? '').trim() || null,
      day: entry.day.trim(),
      start: entry.start.trim(),
      end: entry.end.trim(),
      venue: (entry.venue ?? '').trim() || null,
    }));
}

/** Full document transcription for scanned PDFs that have no selectable text. */
export async function readDocument(
  data: ArrayBuffer,
  mimeType = 'application/pdf'
): Promise<string> {
  return (
    await generateFromMedia(
      data,
      mimeType,
      `Transcribe the complete attached study document in reading order.

- Preserve headings, bullets and tables as Markdown.
- Transcribe formulas in LaTeX between $ delimiters.
- For diagrams or charts, include their labels and one line beginning "Figure:" describing the relationship shown.
- Do not summarise, correct or add commentary. Output only the document content.
- Inspect every page, including pages made entirely from scanned images.`
    )
  ).trim();
}

export async function extractTimetable(
  data: ArrayBuffer,
  mimeType: string
): Promise<ExtractedClass[]> {
  const raw = await generateFromMedia(data, mimeType, TIMETABLE_PROMPT, {
    responseMimeType: 'application/json',
    responseSchema: timetableSchema,
  });
  return normaliseExtractedClasses(raw);
}

/** Schedule extraction for presentation decks after their slide text is parsed locally. */
export async function extractTimetableFromText(text: string): Promise<ExtractedClass[]> {
  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: timetableSchema,
        temperature: 0.1,
      },
    },
    `${TIMETABLE_PROMPT}\n\nEXTRACTED DOCUMENT TEXT:\n${text.slice(0, MAX_CONTEXT_CHARS)}`
  );
  return normaliseExtractedClasses(raw);
}

/**
 * Reads routing metadata and deliverables from the original PDF/image bytes.
 * This is independent of pdf.js, so image-only and stale-worker PDFs still
 * reach the same subject/deadline pipeline as selectable-text documents.
 */
export async function extractMetadataFromMedia(
  data: ArrayBuffer,
  mimeType: string
): Promise<ExtractedMetadata> {
  const raw = await generateFromMedia(
    data,
    mimeType,
    `Analyze the complete attached university study material.

${todayContext()}

- moduleCode: the official course code, or empty.
- documentType: exactly TimetableSchedule, AcademicCalendar, SubjectMaterial or GeneralNote.
- subjectName: the course name in title case; infer it when necessary.
- summary: 2-4 sentences describing what the material teaches.
- deadlines: every dated assessment, assignment, examination, laboratory,
  project or presentation. Resolve dates to ISO YYYY-MM-DD and stated times to
  24-hour HH:MM. Never invent a missing time.
- For each large assignment, project or presentation, add 3-6 concrete weekly
  milestones and set weeksBeforeDue from 1-8. Do not create milestones for
  exams, quizzes, readings or labs.
- Inspect every page, including scanned images. Return an empty deadlines array
  when none are stated.`,
    { responseMimeType: 'application/json', responseSchema: metadataSchema }
  );

  const parsed = parseJson<Partial<ExtractedMetadata>>(raw);
  if (!isMetadata(parsed)) throw new AiError('The document metadata could not be read.');

  return {
    documentType: normaliseDocumentType(parsed.documentType),
    moduleCode: parsed.moduleCode?.trim() || null,
    subjectName: parsed.subjectName?.trim() || null,
    summary: parsed.summary?.trim() || null,
    deadlines: Array.isArray(parsed.deadlines)
      ? parsed.deadlines
          .filter(
            (deadline) => deadline && typeof deadline.title === 'string' && deadline.title.trim()
          )
          .map((deadline) => ({
            title: deadline.title.trim(),
            dueDate: deadline.dueDate?.trim() || null,
            dueTime: deadline.dueTime?.trim() || null,
            kind: deadline.kind?.trim() || null,
            milestones: Array.isArray(deadline.milestones)
              ? deadline.milestones
                  .filter(
                    (milestone) =>
                      milestone?.title?.trim() && Number.isFinite(milestone.weeksBeforeDue)
                  )
                  .map((milestone) => ({
                    title: milestone.title.trim(),
                    weeksBeforeDue: Math.max(1, Math.min(8, Math.round(milestone.weeksBeforeDue))),
                  }))
              : [],
          }))
      : [],
  };
}

function normaliseDocumentType(
  value: unknown
): ExtractedMetadata['documentType'] {
  return value === 'TimetableSchedule' ||
    value === 'AcademicCalendar' ||
    value === 'SubjectMaterial' ||
    value === 'GeneralNote'
    ? value
    : 'SubjectMaterial';
}

/* ------------------------------------------------------------------ *
 * Academic calendar and exam strategy
 * ------------------------------------------------------------------ */

const academicCalendarSchema = Schema.array({
  items: Schema.object({
    properties: {
      name: Schema.string({ description: 'Institution-neutral term name.' }),
      code: Schema.string({ description: 'Official term code, or empty.' }),
      startDate: Schema.string({
        description: 'First teaching date, ISO YYYY-MM-DD.',
      }),
      teachingEndDate: Schema.string({
        description: 'Last teaching date, ISO YYYY-MM-DD.',
      }),
      teachingWeeks: Schema.number({
        description: 'Published teaching duration in weeks.',
      }),
      studyLeaveStart: Schema.string({ description: 'ISO date, or empty.' }),
      studyLeaveEnd: Schema.string({ description: 'ISO date, or empty.' }),
      examStart: Schema.string({ description: 'ISO date, or empty.' }),
      examEnd: Schema.string({ description: 'ISO date, or empty.' }),
      endDate: Schema.string({
        description: 'End of exam or term break window, ISO YYYY-MM-DD.',
      }),
    },
    optionalProperties: ['code'],
  }),
});

function isoOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

const ACADEMIC_CALENDAR_PROMPT = `This is an official academic calendar. Extract every teaching term shown.

This must work across universities, colleges and training providers. Do not
assume semesters, trimesters, quarters, 14-week terms or any institution name.
Use the document's own dates and labels.

- "startDate" and "teachingEndDate" are the teaching/learning window, not orientation.
- "teachingWeeks" is the stated teaching duration. If unstated, calculate whole
  calendar weeks covered by teaching and round to the nearest sensible integer.
- Keep study/revision leave separate from examinations.
- Always return studyLeaveStart, studyLeaveEnd, examStart and examEnd. Use an
  empty string only when the document truly has no such window. A range printed
  over two rows or columns still has both a start and an end.
- "endDate" is the latest boundary belonging to that term: exam end, or term
  break end when the calendar explicitly includes that break.
- Expand every date to ISO YYYY-MM-DD. Resolve cross-year ranges correctly.
- Return all terms in chronological order. Ignore branding and disclaimers.`;

function normaliseAcademicCalendar(raw: string): ExtractedAcademicTerm[] {
  const parsed = parseJson<ExtractedAcademicTerm[]>(raw);
  if (!Array.isArray(parsed)) throw new AiError('No academic terms could be read from that file.');

  return parsed
    .map((term) => ({
      name: String(term?.name ?? '').trim(),
      code: String(term?.code ?? '').trim() || null,
      startDate: isoOrNull(term?.startDate) ?? '',
      teachingEndDate: isoOrNull(term?.teachingEndDate) ?? '',
      teachingWeeks: Math.max(1, Math.min(30, Math.round(Number(term?.teachingWeeks) || 0))),
      studyLeaveStart: isoOrNull(term?.studyLeaveStart),
      studyLeaveEnd: isoOrNull(term?.studyLeaveEnd),
      examStart: isoOrNull(term?.examStart),
      examEnd: isoOrNull(term?.examEnd),
      endDate: isoOrNull(term?.endDate) ?? '',
    }))
    .filter((term) => term.name && term.startDate && term.teachingEndDate && term.endDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Reads any institution's official term calendar; names and branding are ignored. */
export async function extractAcademicCalendar(
  data: ArrayBuffer,
  mimeType: string
): Promise<ExtractedAcademicTerm[]> {
  const raw = await generateFromMedia(
    data,
    mimeType,
    ACADEMIC_CALENDAR_PROMPT,
    {
      responseMimeType: 'application/json',
      responseSchema: academicCalendarSchema,
    }
  );
  return normaliseAcademicCalendar(raw);
}

/** Fast path for selectable-text PDFs after local PDF.js extraction. */
export async function extractAcademicCalendarFromText(
  text: string
): Promise<ExtractedAcademicTerm[]> {
  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: academicCalendarSchema,
        temperature: 0.1,
      },
    },
    `${ACADEMIC_CALENDAR_PROMPT}\n\nEXTRACTED DOCUMENT TEXT:\n${text.slice(0, MAX_CONTEXT_CHARS)}`
  );
  return normaliseAcademicCalendar(raw);
}

const revisionPlanSchema = Schema.array({
  items: Schema.object({
    properties: {
      subjectId: Schema.string(),
      title: Schema.string(),
      date: Schema.string({ description: 'ISO YYYY-MM-DD.' }),
      minutes: Schema.number(),
      focus: Schema.string(),
    },
  }),
});

export async function generateExamRevisionPlan(input: {
  studyLeaveStart: string;
  studyLeaveEnd: string;
  subjects: {
    id: string;
    name: string;
    creditHours: number;
    examDate: string;
  }[];
}): Promise<RevisionPlanItem[]> {
  const parsed = await generateJson<RevisionPlanItem[]>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: revisionPlanSchema,
        temperature: 0.15,
      },
    },
    `Build a revision plan from ${input.studyLeaveStart} through ${input.studyLeaveEnd}.

Allocate more time to higher-credit subjects and exams that arrive sooner, while
leaving recovery space between long sessions. Every item must be on a date inside
the window, last 30-180 minutes, use the exact supplied subjectId, and name a
specific revision outcome rather than "study subject". The exam order and gaps
are constraints, not suggestions.

SUBJECTS AND EXAMS:
${JSON.stringify(input.subjects)}`,
    (value): value is RevisionPlanItem[] => Array.isArray(value)
  );

  return parsed
    .filter(
      (item) =>
        item &&
        input.subjects.some((subject) => subject.id === item.subjectId) &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.date)
    )
    .map((item) => ({
      subjectId: item.subjectId,
      title: item.title.trim(),
      date: item.date,
      minutes: Math.max(30, Math.min(180, Math.round(item.minutes / 15) * 15)),
      focus: item.focus.trim(),
    }));
}

/* ------------------------------------------------------------------ *
 * Flashcards
 * ------------------------------------------------------------------ */

const flashcardSchema = Schema.array({
  items: Schema.object({
    properties: {
      front: Schema.string({
        description: 'The prompt side: a question or a term.',
      }),
      back: Schema.string({ description: 'The answer side.' }),
      concept: Schema.string({ description: '2-5 word topic label.' }),
    },
    optionalProperties: ['concept'],
  }),
});

export async function generateFlashcards(context: string, count = 20): Promise<GeneratedCard[]> {
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
  if (valid.length === 0) throw new AiError('No usable flashcards came back from this material.');
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
      modelAnswer: Schema.string({
        description: 'What a full-mark answer contains.',
      }),
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
  if (valid.length === 0) throw new AiError('No usable questions came back from this material.');
  return valid.map((entry) => ({
    question: entry.question.trim(),
    modelAnswer: entry.modelAnswer?.trim() || '',
    concept: entry.concept?.trim() || null,
  }));
}

const gradeSchema = Schema.object({
  properties: {
    score: Schema.number({ description: '0-100. Partial credit is expected.' }),
    verdict: Schema.string({
      description: 'One short sentence of overall judgement.',
    }),
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

/* ------------------------------------------------------------------ *
 * Lecture log
 * ------------------------------------------------------------------ */

const lectureSchema = Schema.object({
  properties: {
    title: Schema.string({
      description: 'Short title for the class, max 8 words.',
    }),
    topic: Schema.string({
      description: 'Chapter or topic covered, as named by the course.',
    }),
    reachedSection: Schema.string({
      description: 'How far inside the topic the class reached, e.g. "4.2". Empty if unstated.',
    }),
    notes: Schema.string({
      description: 'Markdown rundown of what the class covered.',
    }),
    keyPoints: Schema.array({ items: Schema.string() }),
    followUps: Schema.array({ items: Schema.string() }),
  },
  optionalProperties: ['topic', 'reachedSection'],
});

/**
 * Turns "today we did topic 4 and got to 4.2" into a set of notes.
 *
 * The student's sentence carries almost no content — the content is in the
 * subject's uploaded material, which is why the corpus is passed alongside it.
 * The model's job is to find the stated range inside that material and write it
 * up, not to invent a lecture from the sentence.
 */
export async function summariseLecture(input: {
  subjectName: string;
  entry: string;
  /** The subject's own material; the notes are written from this. */
  context: string;
  /** What earlier classes covered, so the rundown starts where they stopped. */
  previous?: string[];
}): Promise<LectureRundown> {
  const parsed = await generateJson<LectureRundown>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: lectureSchema,
        temperature: 0.3,
      },
    },
    `A student has just come out of a ${input.subjectName} class and written down
what was covered. Write up that class for them.

WHAT THE STUDENT WROTE
${input.entry}

${
  input.previous?.length
    ? `WHAT EARLIER CLASSES COVERED (most recent first)\n${input.previous
        .slice(0, 8)
        .map((line) => `- ${line}`)
        .join('\n')}\n`
    : ''
}
Produce:
- "topic": the chapter or topic covered, named the way the course material names
  it. If the student wrote "topic 4" and the material calls it "4. Normalisation",
  return "4. Normalisation". Empty only if nothing identifies it.
- "reachedSection": the furthest point reached, exactly as the student states it
  ("4.2", "slide 31", "the end of the chapter"). Empty if they did not say.
- "title": a short human title for this class.
- "notes": the actual rundown, in Markdown, and this is the part that matters.
  Teach the range the student says was covered, drawn from the SOURCE MATERIAL
  below — definitions, the reasoning, worked steps, and any formula written out.
  Use "## " headings and short paragraphs. Aim for something a student can
  revise from without reopening the slides. Do not describe the class ("the
  lecturer explained…"); write the content itself.
- "keyPoints": 3-6 one-line takeaways.
- "followUps": what to read or practise before the next class, based on where
  this one stopped. 2-4 items, specific.

Rules:
- Stay inside the range the student states. If they stopped at 4.2, do not write
  up 4.3.
- Everything factual must come from the source material. Where the material does
  not cover something the student mentions, say so in one line inside "notes"
  rather than inventing it.
- If there is no source material at all, write the best general rundown you can
  for the stated topic and open "notes" with one line saying it was written
  without the course material.

SOURCE MATERIAL
${input.context.slice(0, 300_000) || '(none uploaded for this subject yet)'}`,
    (value): value is LectureRundown =>
      !!value && typeof (value as LectureRundown).notes === 'string'
  );

  return {
    title: parsed.title?.trim() || 'Class notes',
    topic: parsed.topic?.trim() || null,
    reachedSection: parsed.reachedSection?.trim() || null,
    notes: parsed.notes?.trim() || '',
    keyPoints: (parsed.keyPoints ?? []).map((line) => String(line).trim()).filter(Boolean),
    followUps: (parsed.followUps ?? []).map((line) => String(line).trim()).filter(Boolean),
  };
}

/**
 * The question a student would rather not interrupt the lecturer with.
 *
 * Deliberately terse: this is answered mid-class on a phone, so a wall of text
 * is worse than no answer. Prose, not JSON — it is read, never parsed.
 */
export async function askInClass(input: {
  subjectName: string;
  question: string;
  context: string;
  /** What the class is on right now, when the log knows. */
  topic?: string | null;
}): Promise<string> {
  return generateProse(
    `A student is sitting in a ${input.subjectName} lecture${
      input.topic ? ` on "${input.topic}"` : ''
    } and does not want to interrupt to ask this. Answer it.

QUESTION
${input.question}

- Answer in under 150 words. Lead with the answer, then the reason.
- Markdown, but no headings — bullets and bold at most.
- Use the course's own notation and terminology, from the material below.
- A formula goes in LaTeX between $ delimiters.
- If the material does not settle it, answer from general knowledge of the
  field and say in one short line that it is not in their material.

COURSE MATERIAL
${input.context.slice(0, 200_000) || '(none uploaded yet)'}`,
    0.3
  );
}

/* ------------------------------------------------------------------ *
 * Assignments, tutorials and labs
 * ------------------------------------------------------------------ */

const assignmentSchema = Schema.object({
  properties: {
    title: Schema.string({ description: 'The task as the brief names it.' }),
    kind: Schema.string({
      description: 'assignment | tutorial | lab | project',
    }),
    summary: Schema.string({
      description: 'Markdown rundown of what is being asked.',
    }),
    steps: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string({ description: 'One actionable step.' }),
          detail: Schema.string({ description: 'What doing it involves.' }),
        },
        optionalProperties: ['detail'],
      }),
    }),
    deliverables: Schema.array({ items: Schema.string() }),
    markingNotes: Schema.string({
      description: 'How it is graded, if stated.',
    }),
    estimatedHours: Schema.number({
      description: 'Realistic total hours of work.',
    }),
    dueDate: Schema.string({
      description: 'ISO YYYY-MM-DD, or empty if not stated.',
    }),
    dueTime: Schema.string({ description: '24-hour HH:MM, or empty.' }),
  },
  optionalProperties: ['kind', 'markingNotes', 'estimatedHours', 'dueDate', 'dueTime'],
});

/**
 * Reads an assignment, tutorial or lab brief into a plan with a deadline.
 *
 * Today's date is passed in because briefs say "due next Friday" far more often
 * than they print an ISO date, and the model has no clock.
 */
export async function breakDownAssignment(input: {
  subjectName: string;
  /** Extracted text of the brief. */
  text: string;
  fileName?: string | null;
  /** ISO YYYY-MM-DD of today, for resolving relative deadlines. */
  today: string;
}): Promise<AssignmentBreakdown> {
  const parsed = await generateJson<AssignmentBreakdown>(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: assignmentSchema,
        temperature: 0.2,
      },
    },
    `This is a brief for a piece of assessed work in ${input.subjectName}${
      input.fileName ? ` (file: ${input.fileName})` : ''
    }. Today is ${input.today}.

Read it and produce a plan the student can start from.

- "title": what the brief calls this task.
- "kind": one of assignment, tutorial, lab, project — whichever it actually is.
- "summary": Markdown. What is being asked, in the student's terms. Open with
  one sentence stating the deliverable, then cover the requirements, the
  constraints (word count, language, group size, format) and anything easy to
  miss. Quote exact figures from the brief rather than paraphrasing them.
- "steps": the work broken into 4-10 ordered, actually-actionable steps. "Read
  the brief" is not a step. Each "detail" says what doing it involves.
- "deliverables": every artefact to hand in — report, code, video, log sheet —
  with its format where stated.
- "markingNotes": how marks are allocated, if the brief says. Empty if not.
- "estimatedHours": your honest estimate of total work.
- "dueDate": the deadline as ISO YYYY-MM-DD. Resolve relative dates against
  today's date above. Empty if the brief states none — never guess one.
- "dueTime": 24-hour HH:MM if a time of day is stated, else empty.

BRIEF
${input.text.slice(0, MAX_CONTEXT_CHARS)}`,
    (value): value is AssignmentBreakdown =>
      !!value && typeof (value as AssignmentBreakdown).summary === 'string'
  );

  return {
    title: parsed.title?.trim() || 'Untitled task',
    kind: parsed.kind?.trim() || null,
    summary: parsed.summary?.trim() || '',
    steps: (parsed.steps ?? [])
      .filter((step) => step && typeof step.title === 'string' && step.title.trim())
      .map((step) => ({
        title: step.title.trim(),
        detail: step.detail?.trim() || null,
      })),
    deliverables: (parsed.deliverables ?? []).map((line) => String(line).trim()).filter(Boolean),
    markingNotes: parsed.markingNotes?.trim() || null,
    estimatedHours:
      typeof parsed.estimatedHours === 'number' && parsed.estimatedHours > 0
        ? Math.round(parsed.estimatedHours * 10) / 10
        : null,
    dueDate: parsed.dueDate?.trim() || null,
    dueTime: parsed.dueTime?.trim() || null,
  };
}

/* ------------------------------------------------------------------ *
 * The co-pilot
 * ------------------------------------------------------------------ */

/**
 * One tool the assistant can reach for.
 *
 * The declarations live here and the implementations live in
 * services/copilot, because what the model is allowed to do is a different
 * question from how the app does it — and only one of those two should change
 * when Firestore does.
 */
/**
 * How long any single round may take before the assistant gives up.
 *
 * Tool use has two model rounds (choose a tool, then answer from its result).
 * Cold regional calls can exceed 25 seconds even while Vision is healthy, so
 * keep this under the SDK transport timeout but long enough for a real turn.
 */
const COPILOT_TIMEOUT_MS = 90_000;

export const COPILOT_TOOLS: FunctionDeclarationsTool[] = [
  {
    functionDeclarations: [
      {
        name: 'find_subject',
        description:
          'Find a subject in the student’s library by name or course code. Call this ' +
          'before any tool that needs a subjectId. Returns the closest matches.',
        parameters: Schema.object({
          properties: {
            query: Schema.string({
              description: 'Name, partial name or course code.',
            }),
          },
        }),
      },
      {
        name: 'create_task',
        description:
          'Add a to-do with an optional deadline. Use for anything the student says they ' +
          'have to do, hand in, revise or prepare.',
        parameters: Schema.object({
          properties: {
            title: Schema.string({
              description: 'What has to be done, in their words.',
            }),
            subjectId: Schema.string({
              description: 'From find_subject. Empty if none fits.',
            }),
            dueDate: Schema.string({
              description: 'ISO YYYY-MM-DD. Empty if not stated.',
            }),
            dueTime: Schema.string({
              description: '24-hour HH:MM. Empty if not stated.',
            }),
            priority: Schema.string({ description: 'low, medium or high.' }),
          },
          optionalProperties: ['subjectId', 'dueDate', 'dueTime', 'priority'],
        }),
      },
      {
        name: 'get_schedule',
        description:
          'Read the student’s timetable. Returns their classes with day, time, room and ' +
          'session. Use for "where is my next class", "what do I have tomorrow", "am I free".',
        parameters: Schema.object({
          properties: {
            when: Schema.string({
              description: '"next", "today", "tomorrow", a weekday name, or "week".',
            }),
          },
          optionalProperties: ['when'],
        }),
      },
      {
        name: 'get_tasks',
        description: 'Read open to-dos and their deadlines, soonest first.',
        parameters: Schema.object({
          properties: {
            subjectId: Schema.string({
              description: 'Limit to one subject. Empty for all.',
            }),
          },
          optionalProperties: ['subjectId'],
        }),
      },
      {
        name: 'get_week_plan',
        description:
          'What a course is teaching this week, from its teaching plan: the topic, any lab or ' +
          'tutorial, and anything assessed that week. Use for "what are we covering this week", ' +
          '"what is the topic for week 5", "what is due this week in…".',
        parameters: Schema.object({
          properties: {
            subjectId: Schema.string({ description: 'From find_subject. Empty for all subjects.' }),
            week: Schema.number({
              description: 'A specific teaching week. Omit for the current week.',
            }),
          },
          optionalProperties: ['subjectId', 'week'],
        }),
      },
      {
        name: 'get_assignments',
        description:
          'Read the coursework on the Tutorials & Assignments tab: briefs, the steps and ' +
          'deliverables of each, marking notes and deadlines. Use for anything about an ' +
          'assignment, tutorial, lab or project — "what do I have to hand in", "what is the ' +
          'brief for…", "what are the steps for my assignment".',
        parameters: Schema.object({
          properties: {
            subjectId: Schema.string({
              description: 'Limit to one subject. Empty for all.',
            }),
            includeDone: Schema.string({
              description: '"yes" to include finished work. Defaults to open work only.',
            }),
          },
          optionalProperties: ['subjectId', 'includeDone'],
        }),
      },
      {
        name: 'search_material',
        description:
          'Answer a question from the material the student has uploaded for one subject, ' +
          'or summarise it. Use for "summarise my notes on…", "what did we cover in…".',
        parameters: Schema.object({
          properties: {
            subjectId: Schema.string({ description: 'From find_subject.' }),
            question: Schema.string({
              description: 'What to answer or summarise.',
            }),
          },
        }),
      },
      {
        name: 'log_lecture',
        description:
          'Record what a class covered, in the student’s own words, so it is written up ' +
          'and filed under the subject.',
        parameters: Schema.object({
          properties: {
            subjectId: Schema.string({ description: 'From find_subject.' }),
            entry: Schema.string({
              description: 'What they said the class covered.',
            }),
          },
        }),
      },
    ],
  },
];

export type CopilotTurn = { role: 'user' | 'model'; text: string };

/** What a tool call did, so the UI can show it rather than just the prose. */
export type CopilotAction = { tool: string; summary: string };

/**
 * One exchange with the assistant, including any tools it decides to use.
 *
 * The loop is capped: a model that keeps calling tools without answering would
 * otherwise spend a student's quota in a circle. Four rounds is more than any
 * real request needs — find a subject, read something, write something, answer.
 */
export async function copilotTurn(input: {
  message: string;
  history: CopilotTurn[];
  /** A short brief of who the student is and what today looks like. */
  brief: string;
  run: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ result: unknown; summary?: string }>;
}): Promise<{ reply: string; actions: CopilotAction[] }> {
  const copilotParams: Omit<ModelParams, 'model'> = {
    tools: COPILOT_TOOLS,
    systemInstruction: `You are Notomi, a study assistant inside a student's own app.

You can read and change their timetable, subjects, notes and to-dos through the
tools you have. Use them rather than guessing: if they ask where their next
class is, call get_schedule; if they mention something due, call create_task.

- Look up a subject with find_subject before using its id. If nothing matches,
  say so and ask which subject they mean rather than inventing one.
- Confirm what you did in one short sentence. "Added 'Essay draft' to Research
  Method, due Friday 14 March." No preamble, no bullet lists for one fact.
- Never invent a deadline, a room or a fact about their material. If it is not
  in what the tools return, say you do not have it.
- They are usually on a phone, often walking. Two sentences is a good answer;
  five is a bad one.

TODAY
${input.brief}`,
    // Answers here are one or two sentences, usually read while walking
    // between classes. Deliberation buys nothing and costs the whole wait.
    generationConfig: { temperature: 0.3, thinkingConfig: FAST_THINKING },
  };

  const contents: Content[] = [
    ...input.history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
    { role: 'user', parts: [{ text: input.message }] },
  ];

  const actions: CopilotAction[] = [];

  /**
   * A bounded wait.
   *
   * A request to an unreachable service does not fail quickly — it hangs until
   * the socket gives up, which can be the better part of a minute. Somebody
   * walking between classes will have put the phone away long before then, so
   * the assistant admits defeat at a length a person will actually wait.
   */
  const deadline = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('That took too long. Check your connection and try again.')),
        COPILOT_TIMEOUT_MS
      );
      void work.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });

  try {
    const send = () =>
      runWithModelFallback('copilot chat', copilotParams, (candidate) =>
        candidate.generateContent({ contents })
      );
    let response = (await deadline(send())).response;

    for (let round = 0; round < 4; round += 1) {
      const calls = response.functionCalls();
      if (!calls || calls.length === 0) break;

      const modelContent = response.candidates?.[0]?.content;
      if (!modelContent) throw new Error('The AI requested a tool without returning its message.');
      contents.push(modelContent);

      const replies: Part[] = [];
      for (const call of calls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        let outcome: { result: unknown; summary?: string };

        try {
          outcome = await input.run(call.name, args);
        } catch (error) {
          // Handed back to the model rather than thrown: it can tell the
          // student what failed far better than a stack trace can.
          outcome = {
            result: {
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }

        if (outcome.summary) actions.push({ tool: call.name, summary: outcome.summary });
        replies.push({
          functionResponse: {
            name: call.name,
            response: { result: outcome.result },
          },
        });
      }

      // Firebase's ChatSession currently labels an all-function-response turn
      // as role "function". Gemini 3.6 accepts SYSTEM, USER and MODEL roles and
      // rejects that second round with HTTP 400. A function result is input
      // from the client, so send it explicitly as USER while retaining the
      // model's function-call content immediately before it.
      contents.push({ role: 'user', parts: replies });
      response = (await deadline(send())).response;
    }

    return { reply: response.text().trim(), actions };
  } catch (error) {
    throw new AiError(describe(error), error);
  }
}

/* ------------------------------------------------------------------ *
 * Teaching plans
 * ------------------------------------------------------------------ */

/**
 * A teaching plan is the week-by-week spine of a course: what is taught in
 * week 5, and what is due in week 9. Universities publish them as a table, and
 * the table is what a student actually wants their calendar to know.
 */
const teachingPlanSchema = Schema.object({
  properties: {
    courseCode: Schema.string({ description: 'Course code printed on the plan, or empty.' }),
    courseName: Schema.string({ description: 'Course title, or empty.' }),
    weeks: Schema.array({
      items: Schema.object({
        properties: {
          week: Schema.number({ description: 'Teaching week number, 1-based.' }),
          topic: Schema.string({ description: 'What is taught that week.' }),
          activity: Schema.string({ description: 'Lab, tutorial or practical, or empty.' }),
          assessment: Schema.string({
            description: 'Assessment due that week, e.g. "Assignment 1 (20%)". Empty if none.',
          }),
          dueDate: Schema.string({
            description: 'ISO YYYY-MM-DD if the plan prints a date. Empty otherwise.',
          }),
        },
        optionalProperties: ['activity', 'assessment', 'dueDate'],
      }),
    }),
  },
  optionalProperties: ['courseCode', 'courseName'],
});

const TEACHING_PLAN_PROMPT = `You are reading a university teaching plan or course outline.

Return the week-by-week schedule exactly as printed. Rules:
- One entry per teaching week, numbered as the document numbers them.
- "topic" is the lecture subject for that week, copied not paraphrased.
- "assessment" only when something is submitted or sat that week. A reading or
  a lab exercise is an activity, not an assessment.
- "dueDate" only when the document prints an actual date. Never infer one from
  a week number — the calendar anchors those separately.
- Skip study breaks and revision weeks that teach nothing, rather than emitting
  an entry with an empty topic.`;

export type ExtractedTeachingPlan = {
  courseCode: string;
  courseName: string;
  weeks: {
    week: number;
    topic: string;
    activity: string;
    assessment: string;
    dueDate: string | null;
  }[];
};

function normaliseTeachingPlan(raw: unknown): ExtractedTeachingPlan {
  const source = (raw ?? {}) as Record<string, unknown>;
  const weeks = Array.isArray(source.weeks) ? source.weeks : [];

  return {
    courseCode: typeof source.courseCode === 'string' ? source.courseCode.trim() : '',
    courseName: typeof source.courseName === 'string' ? source.courseName.trim() : '',
    weeks: weeks
      .map((entry) => {
        const week = entry as Record<string, unknown>;
        const number = Number(week.week);
        const date = typeof week.dueDate === 'string' ? week.dueDate.trim() : '';
        return {
          week: Number.isFinite(number) && number > 0 ? Math.round(number) : 0,
          topic: typeof week.topic === 'string' ? week.topic.trim() : '',
          activity: typeof week.activity === 'string' ? week.activity.trim() : '',
          assessment: typeof week.assessment === 'string' ? week.assessment.trim() : '',
          // An empty string is not a date; storing one would put an epoch entry
          // on the calendar every time the model left the field blank.
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        };
      })
      .filter((entry) => entry.week > 0 && entry.topic.length > 0)
      .sort((a, b) => a.week - b.week),
  };
}

export async function extractTeachingPlanFromText(text: string): Promise<ExtractedTeachingPlan> {
  const raw = await generate(
    {
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: teachingPlanSchema,
        temperature: 0.1,
      },
    },
    `${TEACHING_PLAN_PROMPT}\n\nEXTRACTED DOCUMENT TEXT:\n${text.slice(0, MAX_CONTEXT_CHARS)}`
  );
  return normaliseTeachingPlan(raw);
}
