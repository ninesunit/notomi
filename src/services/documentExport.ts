import { Platform } from 'react-native';
import type { ShareableFile } from '@/lib/deviceShare';
import { originalBytes } from '@/services/driveStorage';
import { downloadBlob, safeFileName } from '@/lib/download';

const safeName = (name: string) => safeFileName(name, 'notomi-notes');

export function exportMarkdown(title: string, markdown: string): void {
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${safeName(title)}.md`);
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .trim();
}

export function exportText(title: string, markdown: string): void {
  downloadBlob(
    new Blob([markdownToPlainText(markdown)], { type: 'text/plain;charset=utf-8' }),
    `${safeName(title)}.txt`
  );
}

export async function exportPdf(title: string, markdown: string): Promise<void> {
  if (Platform.OS !== 'web') throw new Error('PDF downloads are currently available in the web app.');
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const margin = 52;
  const width = pdf.internal.pageSize.getWidth() - margin * 2;
  const height = pdf.internal.pageSize.getHeight() - margin;
  const lines = pdf.splitTextToSize(markdownToPlainText(markdown), width) as string[];
  let y = margin;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text(title, margin, y);
  y += 30;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10.5);
  for (const line of lines) {
    if (y > height) {
      pdf.addPage();
      y = margin;
    }
    pdf.text(line, margin, y);
    y += 15;
  }
  pdf.save(`${safeName(title)}.pdf`);
}

/* ------------------------------------------------------------------ *
 * Out of Notomi entirely
 * ------------------------------------------------------------------ */

/**
 * Collects originals so they can be handed to the OS share sheet.
 *
 * Fetched one at a time rather than with Promise.all. A student selecting nine
 * slide decks on a phone would otherwise open nine simultaneous Drive
 * transfers, which is how the migration work earlier ran into throttling — and
 * a share that trips a rate limit fails all of it, not one of it. Sequential is
 * slower and finishes.
 *
 * Documents whose original cannot be fetched are reported rather than thrown:
 * eight files that share is a better outcome than nine that do not, and the
 * caller can say which one was left behind.
 */
export async function filesForSharing(
  documents: {
    fileName: string;
    mimeType?: string | null;
    driveFileId?: string | null;
    r2FileKey?: string | null;
    r2FileUrl?: string | null;
  }[],
  onProgress?: (completed: number, total: number) => void
): Promise<{ files: ShareableFile[]; missing: string[] }> {
  const files: ShareableFile[] = [];
  const missing: string[] = [];

  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    try {
      const blob = await originalBytes(document);
      if (blob) {
        files.push({
          name: document.fileName,
          mimeType: document.mimeType || blob.type || 'application/octet-stream',
          blob,
        });
      } else {
        missing.push(document.fileName);
      }
    } catch {
      missing.push(document.fileName);
    }
    onProgress?.(index + 1, documents.length);
  }

  return { files, missing };
}
