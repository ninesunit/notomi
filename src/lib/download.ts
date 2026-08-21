import { Platform } from 'react-native';

/**
 * Hands the browser a file to save.
 *
 * There were two of these, written independently — one in documentExport, one
 * inlined in ankiExport — and they had already drifted: only one revoked the
 * object URL on a timer, and only one hid the anchor before clicking it. Two
 * copies of a browser workaround is two chances to keep the wrong one.
 *
 * Web only. Native has no filesystem to download into from here, and the
 * callers that run on both share sheets instead.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (Platform.OS !== 'web') throw new Error('Direct downloads are currently available in the web app.');

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a later tick: revoking synchronously can beat the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A file name that survives every filesystem, with a fallback for an empty one. */
export function safeFileName(name: string, fallback: string): string {
  return (
    name
      .trim()
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || fallback
  );
}
