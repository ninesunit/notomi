import { Platform } from 'react-native';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export type FileKind = 'pdf' | 'docx' | 'text';

export type ParsedFile = {
  text: string;
  pageCount: number | null;
  kind: FileKind;
};

const CANONICAL_MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  text: 'text/plain',
};

/**
 * The MIME type the OS hands us is unreliable — Markdown and some DOCX files
 * arrive as an empty string or application/octet-stream, which storage.rules
 * rightly rejects. By the time a file reaches the upload we have already
 * parsed it, so we know what it really is and can label it accurately.
 */
export function canonicalMimeType(kind: FileKind): string {
  return CANONICAL_MIME[kind];
}

export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

/**
 * All extraction happens on the device. Nothing is sent anywhere to be parsed,
 * which is what keeps ingestion free and key-less.
 */
export async function extractText(
  data: ArrayBuffer,
  fileName: string,
  mimeType: string
): Promise<ParsedFile> {
  const kind = classify(fileName, mimeType);

  switch (kind) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'text':
      return { text: new TextDecoder().decode(data), pageCount: null, kind: 'text' };
    default:
      throw new ParseError(
        `Notomi can read PDF, DOCX, TXT and Markdown files. "${fileName}" is not one of those.`
      );
  }
}

function classify(fileName: string, mimeType: string): 'pdf' | 'docx' | 'text' | 'unknown' {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (
    mimeType.includes('wordprocessingml') ||
    extension === 'docx'
  ) {
    return 'docx';
  }
  if (mimeType.startsWith('text/') || ['txt', 'md', 'markdown', 'csv'].includes(extension)) {
    return 'text';
  }
  return 'unknown';
}

function requireWeb(format: string): void {
  if (Platform.OS !== 'web') {
    throw new ParseError(
      `${format} parsing runs in the browser engine. Open Notomi in Safari or a desktop browser to upload ${format} files.`
    );
  }
}

async function extractPdf(data: ArrayBuffer): Promise<ParsedFile> {
  requireWeb('PDF');

  // Loaded lazily so the ~1MB pdf.js bundle stays out of the initial payload
  // and never reaches a native bundle.
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new ParseError('That PDF is password protected. Remove the password and try again.');
    }
    throw new ParseError(`Could not read that PDF: ${message}`);
  }

  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(joinTextItems(content.items));
    page.cleanup();
  }
  await pdf.destroy();

  const text = pages.join('\n\n').trim();
  if (!text) {
    throw new ParseError(
      'No selectable text found — that PDF is probably a scan. Run it through OCR first.'
    );
  }
  return { text, pageCount: pdf.numPages, kind: 'pdf' };
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
