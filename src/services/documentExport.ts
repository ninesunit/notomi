import { Platform } from 'react-native';

function safeName(name: string): string {
  return name.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'notomi-notes';
}

function downloadBlob(blob: Blob, fileName: string): void {
  if (Platform.OS !== 'web') throw new Error('Direct downloads are currently available in the web app.');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

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
