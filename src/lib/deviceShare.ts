/**
 * Handing files to the operating system.
 *
 * Notomi already shares *within* Notomi — to a friend, through Firestore. This
 * is the other direction: out of the app entirely, into WhatsApp, AirDrop, Mail
 * or Files, without Notomi knowing or brokering any of it. The Web Share API
 * does the whole job, so there is no backend here and never should be: the
 * bytes go from the student's device to the OS sheet and nowhere else.
 *
 * Support is genuinely patchy and the two halves are separate. A browser can
 * offer navigator.share for links and text while refusing files, which is why
 * every call goes through canShare() with the actual payload rather than a
 * feature flag — Firefox and most desktop Linux browsers fall in that gap, and
 * a Share button that throws is worse than one that was never shown.
 */

export type ShareableFile = {
  name: string;
  mimeType: string;
  blob: Blob;
};

/** iOS refuses the whole share when one file has a type it will not carry. */
const SAFE_FALLBACK_TYPE = 'application/octet-stream';

function toFile({ name, mimeType, blob }: ShareableFile): File {
  return new File([blob], name, { type: mimeType || blob.type || SAFE_FALLBACK_TYPE });
}

/**
 * Can this device hand these particular files to the OS?
 *
 * Asked with the real files, because navigator.canShare inspects them: size,
 * count and type all decide it, and the answer for one PDF is not the answer
 * for nine.
 */
export function canShareFiles(files: ShareableFile[]): boolean {
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare) return false;
  if (files.length === 0) return false;
  try {
    return navigator.canShare({ files: files.map(toFile) });
  } catch {
    return false;
  }
}

/** Whether a Share affordance is worth rendering at all on this device. */
export function deviceShareSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export class ShareUnsupportedError extends Error {}
export class ShareCancelledError extends Error {}

/**
 * Opens the native share sheet.
 *
 * Resolves once the sheet has been handed the files. It deliberately does not
 * report where they went: the OS does not say, and pretending otherwise would
 * mean showing "Sent to WhatsApp" for a share the student cancelled.
 *
 * A cancelled sheet arrives as AbortError, which is not a failure and must not
 * be shown as one — dismissing a share sheet is a decision, not an error.
 */
export async function shareFiles(files: ShareableFile[], title?: string): Promise<void> {
  if (!canShareFiles(files)) {
    throw new ShareUnsupportedError('This device cannot share files to other apps.');
  }

  try {
    await navigator.share({
      files: files.map(toFile),
      // Title only. A url alongside files makes iOS share the link and quietly
      // drop the attachments, which looks like the files simply vanished.
      ...(title ? { title } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ShareCancelledError('Share cancelled.');
    }
    throw error;
  }
}

/**
 * Saves to the device instead, for everywhere the share sheet does not exist.
 *
 * One file downloads under its own name. Several would fire a burst of
 * downloads that most browsers block after the first, so they are zipped —
 * using the JSZip already bundled for Anki export rather than adding anything.
 */
export async function downloadFiles(files: ShareableFile[], zipName = 'Notomi files'): Promise<void> {
  if (typeof document === 'undefined' || files.length === 0) return;

  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on a turn of the event loop: revoking synchronously can beat the
    // browser to reading the url, and the download silently does nothing.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (files.length === 1) {
    save(files[0].blob, files[0].name);
    return;
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set<string>();
  for (const file of files) {
    // Two documents can legitimately share a filename across subjects, and a
    // zip that silently keeps only the last one loses a student's work.
    let name = file.name;
    for (let n = 2; used.has(name); n += 1) {
      name = file.name.replace(/(\.[^.]+)?$/, (extension) => ` (${n})${extension ?? ''}`);
    }
    used.add(name);
    zip.file(name, file.blob);
  }
  save(await zip.generateAsync({ type: 'blob' }), `${zipName}.zip`);
}
