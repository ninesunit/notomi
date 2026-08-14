import { Platform } from 'react-native';
import { transcribeMedia, readImage, AiError } from '@/lib/ai';
import type { FileKind } from '@/lib/schema';

/**
 * Turns any supported upload into plain text.
 *
 * Text-bearing formats are parsed on the device, which is free and private.
 * Images and media have no client-side equivalent, so their bytes go to Gemini
 * for OCR or transcription — the only path that leaves the device, and the
 * reason the size caps below exist.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export type ParsedFile = {
  text: string;
  pageCount: number | null;
  kind: FileKind;
};

export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
];

const CANONICAL_MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'text/plain',
  image: 'image/png',
  audio: 'audio/mpeg',
  video: 'video/mp4',
};

/**
 * The OS-reported MIME type is unreliable, so the type is decided by what
 * parsing proved the file to be — which keeps storage rules strict.
 */
export function canonicalMimeType(kind: FileKind, reported?: string | null): string {
  // For media the exact subtype matters to Gemini, so a plausible reported
  // type wins over the generic default.
  if ((kind === 'image' || kind === 'audio' || kind === 'video') && reported) {
    if (ACCEPTED_MIME_TYPES.includes(reported)) return reported;
  }
  return CANONICAL_MIME[kind];
}

/**
 * Caps on what is sent to Gemini. Inline request bodies are limited, base64
 * inflates bytes by a third, and long media burns free-tier tokens fast — so
 * an oversized file is refused with an explanation rather than failing
 * opaquely halfway through an upload.
 */
export const SIZE_LIMITS: Record<FileKind, number> = {
  pdf: 50 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  pptx: 50 * 1024 * 1024,
  text: 10 * 1024 * 1024,
  image: 7 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
  video: 15 * 1024 * 1024,
};

export function classify(fileName: string, mimeType: string): FileKind | 'unknown' {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const type = (mimeType || '').toLowerCase();

  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type.includes('wordprocessingml') || extension === 'docx') return 'docx';
  if (type.includes('presentationml') || extension === 'pptx') return 'pptx';
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'heic'].includes(extension)) {
    return 'image';
  }
  if (type.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(extension)) return 'video';
  if (type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac', 'ogg'].includes(extension)) {
    return 'audio';
  }
  if (type.startsWith('text/') || ['txt', 'md', 'markdown', 'csv'].includes(extension)) {
    return 'text';
  }
  return 'unknown';
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export async function extractText(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string
): Promise<ParsedFile> {
  const kind = classify(fileName, mimeType);

  if (kind === 'unknown') {
    throw new ParseError(
      `Notomi cannot read "${fileName}". Supported: PDF, DOCX, PPTX, TXT, Markdown, ` +
        'PNG/JPG/WEBP images, MP4 video, and MP3/M4A audio.'
    );
  }

  const limit = SIZE_LIMITS[kind];
  if (data.byteLength > limit) {
    throw new ParseError(
      `"${fileName}" is ${humanSize(data.byteLength)}, over the ${humanSize(limit)} limit for ` +
        `${kind} files. ${
          kind === 'video' || kind === 'audio'
            ? 'Trim the recording or split it into shorter parts.'
            : 'Try compressing or splitting it.'
        }`
    );
  }

  switch (kind) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'pptx':
      return extractPptx(data);
    case 'text':
      return { text: new TextDecoder().decode(data), pageCount: null, kind: 'text' };
    case 'image':
      return extractImage(data, fileName, mimeType);
    case 'audio':
    case 'video':
      return extractMedia(data, fileName, mimeType, kind);
  }
}

function requireWeb(format: string): void {
  if (Platform.OS !== 'web') {
    throw new ParseError(
      `${format} parsing runs in the browser engine. Open Notomi in Safari or a desktop browser to upload ${format} files.`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Local parsers
 * ------------------------------------------------------------------ */

async function extractPdf(data: ArrayBuffer): Promise<ParsedFile> {
  requireWeb('PDF');

  // Loaded by the browser rather than Metro. See scripts/copy-pdf-worker.mjs:
  // this keeps the parser lazy without tying it to a deploy-specific numeric
  // module id, which is what made uploads fail in already-open PWA sessions.
  const pdfjs = await loadPdfJs();
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

  // PDF.js transfers the supplied buffer to its worker. Passing a view over
  // `data` therefore detaches the *original* ArrayBuffer, and the later R2
  // upload fails with "Cannot perform Construct on a detached ArrayBuffer".
  // Give PDF.js its own owned copy so parsing and original-file storage can
  // safely run in the same ingestion pipeline.
  const pdfWorkerBytes = new Uint8Array(data.byteLength);
  pdfWorkerBytes.set(new Uint8Array(data));
  const loadingTask = pdfjs.getDocument({ data: pdfWorkerBytes });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy();
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new ParseError('That PDF is password protected. Remove the password and try again.');
    }
    throw new ParseError(`Could not read that PDF: ${message}`);
  }

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      // Keep the physical page boundary in the stored corpus. Reel cards and
      // Reader deep links can then cite an exact page without guessing from a
      // character offset, while every existing text consumer still receives
      // ordinary readable text.
      pages.push(`[Page ${pageNumber}]\n${joinTextItems(content.items)}`);
      page.cleanup();
    }

    const text = pages.join('\n\n').trim();
    if (!text) {
      throw new ParseError(
        'No selectable text found — that PDF is probably a scan. Export the pages as images and ' +
          'upload those instead; Notomi will read them with OCR.'
      );
    }
    return { text, pageCount: pdf.numPages, kind: 'pdf' };
  } finally {
    try {
      await pdf.cleanup();
    } finally {
      await loadingTask.destroy();
    }
  }
}

type PdfJs = typeof import('pdfjs-dist');
let pdfJsPromise: Promise<PdfJs> | null = null;
const PDFJS_ASSET_VERSION = '6.2.108';
const PDFJS_PARSER_URL = `/pdf.min.mjs?v=${PDFJS_ASSET_VERSION}`;
const PDFJS_WORKER_URL = `/pdf.worker.min.mjs?v=${PDFJS_ASSET_VERSION}`;

/** A native browser import which Metro cannot rewrite into an async bundle. */
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfJsPromise) {
    const importFromUrl = new Function('url', 'return import(url)') as (
      url: string
    ) => Promise<PdfJs>;
    pdfJsPromise = importFromUrl(PDFJS_PARSER_URL).catch((error) => {
      // A transient network failure should be retryable on the next upload.
      pdfJsPromise = null;
      throw error;
    });
  }
  return pdfJsPromise;
}

/**
 * pdf.js emits positioned fragments, not lines. Reinsert the breaks it flags so
 * the text Gemini receives reads like a document rather than one long run-on.
 */
function joinTextItems(items: unknown[]): string {
  let out = '';
  for (const item of items) {
    const entry = item as { str?: string; hasEOL?: boolean };
    if (typeof entry.str !== 'string') continue;
    out += entry.str;
    if (entry.hasEOL) out += '\n';
    else if (entry.str && !entry.str.endsWith(' ')) out += ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

async function extractDocx(data: ArrayBuffer): Promise<ParsedFile> {
  requireWeb('DOCX');

  const mammoth = await import('mammoth/mammoth.browser');
  const converter = (mammoth as { default?: unknown }).default ?? mammoth;
  const { value } = await (
    converter as { extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }
  ).extractRawText({ arrayBuffer: data });

  const text = value.trim();
  if (!text) throw new ParseError('That DOCX file appears to be empty.');
  return { text, pageCount: null, kind: 'docx' };
}

/**
 * A .pptx is a zip of XML. Slide text lives in <a:t> nodes inside
 * ppt/slides/slideN.xml, and speaker notes in notesSlideN.xml — both are worth
 * capturing, since lecturers often put the real explanation in the notes.
 */
async function extractPptx(data: ArrayBuffer): Promise<ParsedFile> {
  const JSZip = (await import('jszip')).default;

  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ParseError('That PPTX file could not be opened — it may be corrupted.');
  }

  const slideNumber = (path: string): number => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);

  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slidePaths.length === 0) throw new ParseError('No slides found in that PPTX file.');

  const sections: string[] = [];

  for (const path of slidePaths) {
    const index = slideNumber(path);
    const xml = await zip.files[path].async('string');
    const body = xmlText(xml);

    const notesPath = `ppt/notesSlides/notesSlide${index}.xml`;
    const notesXml = zip.files[notesPath] ? await zip.files[notesPath].async('string') : '';
    const notes = notesXml ? xmlText(notesXml) : '';

    if (!body && !notes) continue;
    sections.push(
      [`## Slide ${index}`, body, notes ? `Speaker notes: ${notes}` : ''].filter(Boolean).join('\n')
    );
  }

  const text = sections.join('\n\n').trim();
  if (!text) {
    throw new ParseError(
      'That deck has no extractable text — the slides may be images. Export them as PNGs and ' +
        'upload those; Notomi will read them with OCR.'
    );
  }
  return { text, pageCount: slidePaths.length, kind: 'pptx' };
}

/** Concatenates the <a:t> runs of a slide, preserving paragraph breaks. */
function xmlText(xml: string): string {
  const paragraphs = xml.split(/<a:p[\s>]/).slice(1);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const runs = [...paragraph.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
    const line = decodeXmlEntities(runs.join('')).trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * Shrinks an oversized image before it goes to Gemini.
 *
 * A phone screenshot of a full-width timetable is routinely 3-4k pixels wide
 * and several megabytes, and base64 inflates that by a third. Downscaling to a
 * long edge that still resolves 10pt text cuts the request by an order of
 * magnitude, which is the difference between a scan that works on mobile data
 * and one that times out.
 *
 * Returns the original bytes unchanged if anything is unavailable — this is an
 * optimisation, never a gate.
 */
export async function downscaleImage(
  data: ArrayBuffer,
  mimeType: string,
  maxEdge = 2000
): Promise<{ data: ArrayBuffer; mimeType: string }> {
  const unchanged = { data, mimeType };
  if (Platform.OS !== 'web' || typeof createImageBitmap !== 'function') return unchanged;

  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxEdge) {
      bitmap.close();
      return unchanged;
    }

    const scale = maxEdge / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return unchanged;
    }

    // White behind the image: a transparent PNG flattened onto black would make
    // dark schedule text unreadable.
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      // 0.92 keeps small text crisp; lower starts to smear thin glyphs.
      canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.92)
    );
    if (!blob) return unchanged;

    return { data: await blob.arrayBuffer(), mimeType: 'image/jpeg' };
  } catch {
    return unchanged;
  }
}

/* ------------------------------------------------------------------ *
 * Gemini-backed extraction
 * ------------------------------------------------------------------ */

async function extractImage(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string
): Promise<ParsedFile> {
  try {
    const text = await readImage(data, canonicalMimeType('image', mimeType));
    if (!text.trim()) {
      throw new ParseError(`No readable text was found in "${fileName}".`);
    }
    return { text, pageCount: 1, kind: 'image' };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(
      error instanceof AiError
        ? `Could not read that image: ${error.message}`
        : `Could not read that image: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function extractMedia(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string,
  kind: 'audio' | 'video'
): Promise<ParsedFile> {
  try {
    const text = await transcribeMedia(data, canonicalMimeType(kind, mimeType), kind);
    if (!text.trim()) {
      throw new ParseError(`No transcript could be produced for "${fileName}".`);
    }
    return { text, pageCount: null, kind };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(
      error instanceof AiError
        ? `Could not transcribe that ${kind}: ${error.message}`
        : `Could not transcribe that ${kind}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
