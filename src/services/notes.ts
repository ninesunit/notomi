import { deleteDoc, getDoc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { paths } from '@/lib/paths';
import type {
  NoteAssetNode,
  NoteCanvasState,
  NoteNotebook,
  NoteNode,
  SourceDocument,
  Subject,
} from '@/lib/schema';
import { getDb } from './firebase';
import { blobFromDriveKey, sourceKeyOf } from './driveStorage';
import { getR2FileUrl } from './r2Storage';

const DB_NAME = 'notomi-notes-v1';
const DEFAULT_CAMERA = { x: 0, y: 0, scale: 1 };
const MAX_CLOUD_BYTES = 800_000;
const PDFJS_ASSET_VERSION = '6.2.108';
const PDFJS_PARSER_URL = `/pdf.min.mjs?v=${PDFJS_ASSET_VERSION}`;
const PDFJS_WORKER_URL = `/pdf.worker.min.mjs?v=${PDFJS_ASSET_VERSION}`;

export const NOTE_LIMITS = {
  notebooks: 100,
  pagesPerNotebook: 50,
  nodesPerPage: 5000,
  materialNodesPerPage: 150,
  pdfPagesPerImport: 60,
  localFileBytes: 25 * 1024 * 1024,
} as const;

interface NotesDatabase extends DBSchema {
  canvases: {
    key: string;
    value: NoteCanvasState;
  };
  assets: {
    key: string;
    value: Blob;
  };
  notebooks: {
    key: string;
    value: NoteNotebook;
  };
}

type PdfJs = typeof import('pdfjs-dist');

export type NoteMaterial = {
  subjectId: string;
  subjectName: string;
  document: SourceDocument;
};

export type RenderedMaterialPage = {
  blob: Blob;
  width: number;
  height: number;
  pageNumber: number | null;
};

let dbPromise: Promise<IDBPDatabase<NotesDatabase>> | null = null;
let pdfPromise: Promise<PdfJs> | null = null;

function localKey(uid: string, canvasId: string): string {
  return `${uid}:${canvasId}`;
}

function database(): Promise<IDBPDatabase<NotesDatabase>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Notomi Notes needs a browser with IndexedDB support.'));
  }
  if (!dbPromise) {
    dbPromise = openDB<NotesDatabase>(DB_NAME, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases');
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
        if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks');
      },
    });
  }
  return dbPromise;
}

function cloudNodes(nodes: NoteNode[]): NoteNode[] {
  return nodes.map((node) => {
    if (node.type === 'stroke') return node;
    const { previewUrl: _previewUrl, ...data } = node.data;
    return { ...node, data };
  });
}

function cleanState(state: NoteCanvasState): NoteCanvasState {
  return {
    ...state,
    camera: {
      x: Number.isFinite(state.camera.x) ? state.camera.x : 0,
      y: Number.isFinite(state.camera.y) ? state.camera.y : 0,
      scale: Number.isFinite(state.camera.scale)
        ? Math.min(4, Math.max(0.2, state.camera.scale))
        : 1,
    },
    nodes: Array.isArray(state.nodes) ? state.nodes : [],
  };
}

export function blankNoteCanvas(canvasId = 'main'): NoteCanvasState {
  return {
    id: canvasId,
    title: 'Notomi Notes',
    nodes: [],
    camera: DEFAULT_CAMERA,
    updatedAt: Date.now(),
  };
}

export async function saveNoteCanvasLocal(
  uid: string,
  notebookId: string,
  state: NoteCanvasState
): Promise<void> {
  const db = await database();
  await db.put(
    'canvases',
    { ...state, nodes: cloudNodes(state.nodes) },
    localKey(uid, `${notebookId}:${state.id}`)
  );
}

export async function saveNoteAsset(assetKey: string, blob: Blob): Promise<void> {
  const db = await database();
  await db.put('assets', blob, assetKey);
}

export async function loadNoteAsset(assetKey: string): Promise<Blob | undefined> {
  const db = await database();
  return db.get('assets', assetKey);
}

export async function syncNoteCanvasCloud(
  uid: string,
  notebookId: string,
  state: NoteCanvasState
): Promise<void> {
  if (state.nodes.length > NOTE_LIMITS.nodesPerPage) {
    throw new Error(`This page has reached its ${NOTE_LIMITS.nodesPerPage.toLocaleString()} object safety limit.`);
  }
  const payload = compressToUTF16(
    JSON.stringify({
      version: 1,
      nodes: cloudNodes(state.nodes),
      camera: state.camera,
    })
  );
  const bytes = new Blob([payload]).size;
  if (bytes > MAX_CLOUD_BYTES) {
    throw new Error(
      'This board is safely stored on this device, but its compressed backup is too large for one Firestore document.'
    );
  }

  await setDoc(
    paths.noteNotebookPage(getDb(), uid, notebookId, state.id),
    {
      title: state.title,
      payload,
      nodeCount: state.nodes.length,
      version: 1,
      clientUpdatedAt: state.updatedAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function loadNoteCanvas(
  uid: string,
  notebookId: string,
  canvasId: string
): Promise<NoteCanvasState> {
  const db = await database();
  const key = localKey(uid, `${notebookId}:${canvasId}`);
  const local = await db.get('canvases', key);
  const remoteSnapshot = await getDoc(
    paths.noteNotebookPage(getDb(), uid, notebookId, canvasId)
  ).catch(() => null);

  let remote: NoteCanvasState | null = null;
  if (remoteSnapshot?.exists()) {
    const record = remoteSnapshot.data() as {
      title?: string;
      payload?: string;
      clientUpdatedAt?: number;
    };
    const json = record.payload ? decompressFromUTF16(record.payload) : null;
    if (json) {
      try {
        const parsed = JSON.parse(json) as {
          nodes?: NoteNode[];
          camera?: NoteCanvasState['camera'];
        };
        remote = cleanState({
          id: canvasId,
          title: record.title || 'Notomi Notes',
          nodes: parsed.nodes ?? [],
          camera: parsed.camera ?? DEFAULT_CAMERA,
          updatedAt: record.clientUpdatedAt ?? 0,
        });
      } catch {
        remote = null;
      }
    }
  }

  let chosen = cleanState(
    local && (!remote || local.updatedAt >= remote.updatedAt)
      ? local
      : remote ?? blankNoteCanvas(canvasId)
  );
  // A student may have started drawing while the remote read was in flight.
  // Re-read IndexedDB before committing reconciliation so stale cloud data can
  // never replace a newer local stroke batch.
  const latestLocal = await db.get('canvases', key);
  if (latestLocal && latestLocal.updatedAt > chosen.updatedAt) chosen = cleanState(latestLocal);
  await db.put('canvases', { ...chosen, nodes: cloudNodes(chosen.nodes) }, key);
  return chosen;
}

/**
 * Reads only IndexedDB. Page navigation uses this fast path so a slow or
 * offline Firestore request can never hold the drawing surface on a spinner.
 */
export async function loadNoteCanvasLocal(
  uid: string,
  notebookId: string,
  canvasId: string
): Promise<NoteCanvasState | null> {
  const db = await database();
  const local = await db.get('canvases', localKey(uid, `${notebookId}:${canvasId}`));
  return local ? cleanState(local) : null;
}

export async function saveNotebookLocal(uid: string, notebook: NoteNotebook): Promise<void> {
  const db = await database();
  await db.put('notebooks', notebook, localKey(uid, notebook.id));
}

export async function listNoteNotebooks(uid: string): Promise<NoteNotebook[]> {
  const db = await database();
  const keys = await db.getAllKeys('notebooks');
  const local = (
    await Promise.all(
      keys
        .filter((key) => String(key).startsWith(`${uid}:`))
        .map((key) => db.get('notebooks', key))
    )
  ).filter((entry): entry is NoteNotebook => Boolean(entry));

  const snapshot = await getDocs(paths.noteNotebooks(getDb(), uid)).catch(() => null);
  const merged = new Map(local.map((entry) => [entry.id, entry]));
  if (snapshot) {
    for (const document of snapshot.docs) {
      const remote = { id: document.id, ...document.data() } as NoteNotebook;
      const existing = merged.get(remote.id);
      if (!existing || remote.updatedAt >= existing.updatedAt) merged.set(remote.id, remote);
    }
  }
  let notebooks = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  // The first Notes release stored one canvas at note_canvases/main. Promote
  // it once into the notebook model so yesterday's ink never disappears.
  if (notebooks.length === 0) {
    const legacyLocal = await db.get('canvases', localKey(uid, 'main'));
    const legacySnapshot = await getDoc(paths.noteCanvas(getDb(), uid, 'main')).catch(() => null);
    let legacyRemote: NoteCanvasState | null = null;
    if (legacySnapshot?.exists()) {
      const record = legacySnapshot.data() as { title?: string; payload?: string; clientUpdatedAt?: number };
      const json = record.payload ? decompressFromUTF16(record.payload) : null;
      if (json) {
        try {
          const parsed = JSON.parse(json) as { nodes?: NoteNode[]; camera?: NoteCanvasState['camera'] };
          legacyRemote = cleanState({
            id: 'main',
            title: 'Recovered Notes',
            nodes: parsed.nodes ?? [],
            camera: parsed.camera ?? DEFAULT_CAMERA,
            updatedAt: record.clientUpdatedAt ?? 0,
          });
        } catch {
          legacyRemote = null;
        }
      }
    }
    const legacy = legacyLocal && (!legacyRemote || legacyLocal.updatedAt >= legacyRemote.updatedAt)
      ? legacyLocal
      : legacyRemote;
    if (legacy?.nodes.length) {
      const now = Date.now();
      const recovered: NoteNotebook = {
        id: 'recovered-notes',
        title: 'Recovered Notes',
        subjectId: null,
        subjectCode: null,
        subjectName: null,
        color: '#4A5568',
        pages: [{ id: 'main', title: 'Page 1', order: 0, createdAt: now, updatedAt: now }],
        createdAt: now,
        updatedAt: now,
      };
      await saveNotebookLocal(uid, recovered);
      await saveNoteCanvasLocal(uid, recovered.id, legacy);
      void Promise.all([
        saveNoteNotebook(uid, recovered),
        syncNoteCanvasCloud(uid, recovered.id, legacy),
      ]).catch(() => undefined);
      notebooks = [recovered];
    }
  }
  await Promise.all(notebooks.map((notebook) => saveNotebookLocal(uid, notebook)));
  return notebooks;
}

export async function loadNoteNotebook(uid: string, notebookId: string): Promise<NoteNotebook | null> {
  const db = await database();
  const local = await db.get('notebooks', localKey(uid, notebookId));
  const snapshot = await getDoc(paths.noteNotebook(getDb(), uid, notebookId)).catch(() => null);
  if (!snapshot?.exists()) return local ?? null;
  const remote = { id: snapshot.id, ...snapshot.data() } as NoteNotebook;
  let chosen = local && local.updatedAt > remote.updatedAt ? local : remote;
  const latestLocal = await db.get('notebooks', localKey(uid, notebookId));
  if (latestLocal && latestLocal.updatedAt > chosen.updatedAt) chosen = latestLocal;
  await saveNotebookLocal(uid, chosen);
  return chosen;
}

/** Local-only notebook metadata for instant editor startup and page changes. */
export async function loadNoteNotebookLocal(uid: string, notebookId: string): Promise<NoteNotebook | null> {
  const db = await database();
  return (await db.get('notebooks', localKey(uid, notebookId))) ?? null;
}

export async function saveNoteNotebook(uid: string, notebook: NoteNotebook): Promise<void> {
  await saveNotebookLocal(uid, notebook);
  await setDoc(
    paths.noteNotebook(getDb(), uid, notebook.id),
    {
      title: notebook.title,
      subjectId: notebook.subjectId,
      subjectCode: notebook.subjectCode,
      subjectName: notebook.subjectName,
      color: notebook.color,
      pages: notebook.pages,
      canvasHintDismissed: notebook.canvasHintDismissed === true,
      createdAt: notebook.createdAt,
      updatedAt: notebook.updatedAt,
      version: 1,
      serverUpdatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function deleteNoteNotebook(uid: string, notebook: NoteNotebook): Promise<void> {
  const db = await database();
  await Promise.all(
    notebook.pages.map(async (page) => {
      await db.delete('canvases', localKey(uid, `${notebook.id}:${page.id}`));
      await deleteDoc(paths.noteNotebookPage(getDb(), uid, notebook.id, page.id)).catch(() => undefined);
    })
  );
  await db.delete('notebooks', localKey(uid, notebook.id));
  await deleteDoc(paths.noteNotebook(getDb(), uid, notebook.id)).catch(() => undefined);
}

export async function deleteNotePageLocal(
  uid: string,
  notebookId: string,
  pageId: string
): Promise<void> {
  const db = await database();
  await db.delete('canvases', localKey(uid, `${notebookId}:${pageId}`));
  await deleteDoc(paths.noteNotebookPage(getDb(), uid, notebookId, pageId)).catch(() => undefined);
}

export async function hydrateNoteAssets(nodes: NoteNode[]): Promise<NoteNode[]> {
  let hydrated = await Promise.all(
    nodes.map(async (node) => {
      if (node.type === 'stroke' || node.data.previewUrl) return node;
      const blob = await loadNoteAsset(node.data.assetKey);
      if (!blob) return node;
      return {
        ...node,
        data: { ...node.data, previewUrl: URL.createObjectURL(blob) },
      } satisfies NoteAssetNode;
    })
  );

  // A different device will not have IndexedDB previews, but course-material
  // nodes retain their R2 object key. Re-render each missing source once and
  // repopulate the local cache without ever putting image bytes in Firestore.
  const missingBySource = new Map<string, NoteAssetNode[]>();
  for (const node of hydrated) {
    if (node.type === 'stroke' || node.data.previewUrl || !node.data.sourceFileKey) continue;
    const group = missingBySource.get(node.data.sourceFileKey) ?? [];
    group.push(node);
    missingBySource.set(node.data.sourceFileKey, group);
  }

  for (const [sourceFileKey, targets] of missingBySource) {
    try {
      // Originals in the student's own Drive are fetched with their token
      // rather than a signed url. Keys written by R2 carry no prefix, so this
      // is invisible to every board that predates Drive.
      const fromDrive = await blobFromDriveKey(sourceFileKey);
      let source: Blob;
      if (fromDrive) {
        source = fromDrive;
      } else {
        const response = await fetch(await getR2FileUrl(sourceFileKey));
        if (!response.ok) continue;
        source = await response.blob();
      }
      const isPdf = targets.some((node) => node.type === 'pdf_page');
      const typed = isPdf && !/pdf/i.test(source.type)
        ? new Blob([await source.arrayBuffer()], { type: 'application/pdf' })
        : source;
      const pages = await renderMaterial(typed);
      const previews = new Map<string, string>();
      for (const target of targets) {
        const page = pages.find((entry) => entry.pageNumber === target.data.pageNumber) ?? pages[0];
        if (!page) continue;
        await saveNoteAsset(target.data.assetKey, page.blob);
        previews.set(target.id, URL.createObjectURL(page.blob));
      }
      hydrated = hydrated.map((node) =>
        node.type !== 'stroke' && previews.has(node.id)
          ? { ...node, data: { ...node.data, previewUrl: previews.get(node.id) } }
          : node
      );
    } catch {
      // The layout and ink remain usable offline; the page placeholder will
      // rehydrate the next time the board opens with a connection.
    }
  }
  return hydrated;
}

export async function listNoteMaterials(
  uid: string,
  subjects: Subject[]
): Promise<NoteMaterial[]> {
  const db = getDb();
  const groups = await Promise.all(
    subjects.map(async (subject) => {
      const snapshot = await getDocs(paths.documents(db, uid, subject.id));
      return snapshot.docs.flatMap((entry) => {
        const document = { id: entry.id, ...entry.data() } as SourceDocument;
        if (!/application\/pdf|image\/(png|jpe?g|webp)/i.test(document.mimeType)) return [];
        return [{ subjectId: subject.id, subjectName: subject.name, document }];
      });
    })
  );
  return groups.flat().sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfPromise) {
    const importFromUrl = new Function('url', 'return import(url)') as (
      url: string
    ) => Promise<PdfJs>;
    pdfPromise = importFromUrl(PDFJS_PARSER_URL).catch((error) => {
      pdfPromise = null;
      throw error;
    });
  }
  return pdfPromise;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not render this material.'))),
      type,
      quality
    );
  });
}

async function imageDimensions(blob: Blob): Promise<{
  width: number;
  height: number;
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
  close: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(blob);
  const image = document.createElement('img');
  image.src = url;
  await image.decode();
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
    close: () => URL.revokeObjectURL(url),
  };
}

export async function renderMaterial(
  blob: Blob,
  onProgress?: (completed: number, total: number) => void,
  availableSlots: number = NOTE_LIMITS.materialNodesPerPage
): Promise<RenderedMaterialPage[]> {
  if (/pdf/i.test(blob.type)) {
    const pdfjs = await loadPdfJs();
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
    const pdf = await task.promise;
    const allowedPages = Math.min(NOTE_LIMITS.pdfPagesPerImport, availableSlots);
    if (pdf.numPages > allowedPages) {
      await task.destroy();
      throw new Error(
        `This PDF has ${pdf.numPages} pages, but this Notes page can safely accept ${allowedPages}. Add another notebook page or use a shorter PDF.`
      );
    }
    const rendered: RenderedMaterialPage[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 960 / Math.max(1, natural.width));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        rendered.push({
          blob: await canvasBlob(canvas, 'image/jpeg', 0.8),
          width: viewport.width,
          height: viewport.height,
          pageNumber,
        });
        page.cleanup();
        onProgress?.(pageNumber, pdf.numPages);
      }
      return rendered;
    } finally {
      await pdf.cleanup();
      await task.destroy();
    }
  }

  const image = await imageDimensions(blob);
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
  image.draw(context, width, height);
  image.close();
  return [{ blob: await canvasBlob(canvas, 'image/jpeg', 0.86), width, height, pageNumber: null }];
}

export async function materialBlob(material: NoteMaterial): Promise<Blob> {
  const fromDrive = await blobFromDriveKey(sourceKeyOf(material.document));
  const blob = fromDrive ?? (await r2MaterialBlob(material));
  if (blob.type === material.document.mimeType) return blob;
  return new Blob([await blob.arrayBuffer()], { type: material.document.mimeType });
}

async function r2MaterialBlob(material: NoteMaterial): Promise<Blob> {
  const url = await getR2FileUrl(material.document.r2FileKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the material (${response.status}).`);
  return response.blob();
}

/* ------------------------------------------------------------------ *
 * Reading one page back off the canvas
 * ------------------------------------------------------------------ */

/**
 * Fetches the original a material node came from.
 *
 * The same two-origin lookup the rehydration path uses: Drive keys resolve
 * with the student's own token, R2 keys through a signed url. Kept separate
 * from that path because this one is asked for a single node on demand, not
 * for every node on a board being reopened.
 */
async function sourceBlob(sourceFileKey: string): Promise<Blob | null> {
  const fromDrive = await blobFromDriveKey(sourceFileKey).catch(() => null);
  if (fromDrive) return fromDrive;

  const url = await getR2FileUrl(sourceFileKey).catch(() => '');
  if (!url) return null;
  const response = await fetch(url).catch(() => null);
  return response?.ok ? response.blob() : null;
}

/**
 * The text of one page of a PDF the student has on the canvas.
 *
 * Read on demand rather than stored on the node at import time. Slide text is
 * a few kilobytes a page and a board can hold 150 of them, which would push
 * the canvas payload well past the 800 KB it is allowed to sync — so the
 * cheapest place to keep this text is the file it already lives in.
 *
 * Returns null rather than throwing for a slide that has no text layer at all,
 * which is the normal case for a scanned or photographed page and is worth
 * telling the student plainly instead of failing at them.
 */
export async function pageTextFromSource(
  sourceFileKey: string,
  pageNumber: number
): Promise<string | null> {
  const blob = await sourceBlob(sourceFileKey);
  if (!blob) throw new Error('Could not reach the original file for this slide.');

  const pdfjs = await loadPdfJs();
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const pdf = await task.promise;

  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) return null;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    // pdf.js hands back positioned runs, not lines. Joining on the explicit
    // end-of-line markers keeps bullets apart; without it a slide arrives as
    // one long sentence and reads to the model as a single run-on thought.
    const text = content.items
      .map((item) => {
        const run = item as { str?: string; hasEOL?: boolean };
        return `${run.str ?? ''}${run.hasEOL ? '\n' : ' '}`;
      })
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    page.cleanup();
    return text.length > 0 ? text : null;
  } finally {
    await pdf.cleanup();
    await task.destroy();
  }
}

/**
 * Draws a margin note as an image the canvas can already hold.
 *
 * The node union is strokes and assets — there is no text node, and adding one
 * means touching serialisation, undo, hit-testing and selection across the
 * whole engine. Rendering to an image instead makes the summary an ordinary
 * canvas object on day one: it moves, scales, selects, erases, saves and
 * rehydrates on another device through machinery that is already load-bearing.
 *
 * The trade is honest and worth stating: this note cannot be edited after it
 * lands. A student who wants to change it deletes it and asks again, which for
 * a generated summary is usually what they would do anyway.
 */
export async function renderSummaryNote(
  headline: string,
  points: string[],
  accent = '#B4832A'
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = 2; // Drawn at 2x so it stays sharp when zoomed in on the canvas.
  const width = 320;
  const padding = 18;
  const bodyWidth = width - padding * 2;

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Canvas rendering is unavailable in this browser.');

  const wrap = (text: string, font: string): string[] => {
    measure.font = font;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure.measureText(candidate).width > bodyWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const titleFont = '600 15px Inter, system-ui, sans-serif';
  const bodyFont = '400 13px Inter, system-ui, sans-serif';
  const titleLines = wrap(headline, titleFont);
  const pointLines = points.map((point) => wrap(point, bodyFont));

  // Measured before drawing so the note is exactly as tall as its content —
  // a fixed height would clip four points or leave a gap under two.
  const height =
    padding * 2 +
    titleLines.length * 21 +
    10 +
    pointLines.reduce((sum, lines) => sum + lines.length * 19 + 8, 0);

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = Math.ceil(height) * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
  context.scale(scale, scale);

  context.fillStyle = '#FFFBF0';
  context.fillRect(0, 0, width, height);
  context.fillStyle = accent;
  context.fillRect(0, 0, 4, height);

  let y = padding + 14;
  context.fillStyle = '#1B1A17';
  context.font = titleFont;
  for (const line of titleLines) {
    context.fillText(line, padding, y);
    y += 21;
  }

  y += 6;
  context.font = bodyFont;
  for (const lines of pointLines) {
    context.fillStyle = accent;
    context.fillText('•', padding, y);
    context.fillStyle = '#3A362E';
    for (const line of lines) {
      context.fillText(line, padding + 12, y);
      y += 19;
    }
    y += 8;
  }

  // PNG, not JPEG: this is flat text on a flat ground, where JPEG's ringing
  // shows on every letter edge and the file is no smaller.
  return { blob: await canvasBlob(canvas, 'image/png'), width, height };
}
