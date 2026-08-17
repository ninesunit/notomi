import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { getStroke } from 'perfect-freehand';
import Svg, { ClipPath, Defs, G, Image as SvgImage, Path, Rect } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { Sheet } from '@/components/Sheet';
import { Button, Loading, Notice } from '@/components/ui';
import { useUid } from '@/hooks/useAuth';
import { useCollection } from '@/hooks/useFirestore';
import { useWorkspaceChrome } from '@/hooks/useWorkspaceChrome';
import { driveKey, fetchDriveBlob, isDriveConfigured, pickFromDrive } from '@/lib/driveUtils';
import { paths } from '@/lib/paths';
import type {
  NoteAssetNode,
  NoteBrush,
  NoteCamera,
  NoteNotebook,
  NoteNode,
  NotePoint,
  NoteStrokeNode,
  Subject,
} from '@/lib/schema';
import { getDb } from '@/services/firebase';
import {
  blankNoteCanvas,
  deleteNotePageLocal,
  hydrateNoteAssets,
  listNoteMaterials,
  loadNoteCanvas,
  loadNoteCanvasLocal,
  loadNoteNotebook,
  loadNoteNotebookLocal,
  materialBlob,
  NOTE_LIMITS,
  renderMaterial,
  saveNoteAsset,
  saveNoteCanvasLocal,
  saveNoteNotebook,
  syncNoteCanvasCloud,
  type NoteMaterial,
  type RenderedMaterialPage,
} from '@/services/notes';

type Tool = 'select' | 'pen' | 'eraser' | 'lasso';
type Point = { x: number; y: number };
type Viewport = { width: number; height: number };

type ActiveGesture =
  | { mode: 'draw'; points: NotePoint[] }
  | { mode: 'lasso'; points: Point[] }
  | { mode: 'erase'; before: NoteNode[]; changed: boolean }
  | { mode: 'drag'; start: Point; before: NoteNode[]; ids: string[] }
  | { mode: 'resize'; start: Point; before: NoteNode[]; id: string; width: number; height: number }
  | { mode: 'pan'; start: Point; camera: NoteCamera }
  | null;

type TouchBase = {
  camera: NoteCamera;
  points: Point[];
};

const ACTIVE_PATH_ID = 'notomi-notes-active-path';
const LASSO_PATH_ID = 'notomi-notes-lasso-path';
const DEFAULT_VIEWPORT = { width: 1024, height: 768 };
const NOTE_STYLE =
  Platform.OS === 'web'
    ? ({
        touchAction: 'none',
        overscrollBehavior: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      } as unknown as ViewStyle)
    : undefined;

const TOOLS: { id: Tool; label: string; icon: IconName }[] = [
  { id: 'select', label: 'Select and move', icon: 'mouse-pointer-2' },
  { id: 'pen', label: 'Pen', icon: 'pen-tool' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser' },
  { id: 'lasso', label: 'Lasso', icon: 'lasso' },
];

const PEN_COLORS = ['#18181B', '#B4552D', '#2E6F5E', '#4C5FA8'];

const BRUSHES: { id: NoteBrush; label: string; icon: IconName; size: number; opacity: number }[] = [
  { id: 'fountain', label: 'Fountain pen', icon: 'pen-tool', size: 4.5, opacity: 1 },
  { id: 'gel', label: 'Gel pen', icon: 'circle', size: 3.5, opacity: 1 },
  { id: 'pencil', label: 'Pencil', icon: 'pencil', size: 3, opacity: 0.72 },
  { id: 'highlighter', label: 'Highlighter', icon: 'highlighter', size: 18, opacity: 0.28 },
];

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function strokePath(points: number[][]): string {
  if (points.length === 0) return '';
  const average = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)} Q`;
  for (let index = 1; index < points.length; index += 1) {
    const midpoint = average(points[index - 1], points[index]);
    path += `${points[index - 1][0].toFixed(1)},${points[index - 1][1].toFixed(1)} `;
    path += `${midpoint[0].toFixed(1)},${midpoint[1].toFixed(1)} `;
  }
  const last = points[points.length - 1];
  return `${path}${last[0].toFixed(1)},${last[1].toFixed(1)} Z`;
}

function outlineFor(points: NotePoint[], size: number, brush: NoteBrush = 'fountain'): number[][] {
  const settings = {
    fountain: { thinning: 0.72, smoothing: 0.72, streamline: 0.65 },
    gel: { thinning: 0.18, smoothing: 0.82, streamline: 0.72 },
    pencil: { thinning: 0.48, smoothing: 0.55, streamline: 0.58 },
    highlighter: { thinning: 0.08, smoothing: 0.88, streamline: 0.82 },
  }[brush];
  return getStroke(points, {
    size,
    ...settings,
    easing: (value) => value,
    simulatePressure: false,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
}

function bounds(points: number[][]): { x: number; y: number; width: number; height: number } {
  if (points.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 0.0001) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hitNode(nodes: NoteNode[], point: Point): NoteNode | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (
      point.x >= node.x &&
      point.x <= node.x + node.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height
    ) {
      return node;
    }
  }
  return null;
}

function visibleNode(node: NoteNode, camera: NoteCamera, viewport: Viewport): boolean {
  const margin = 240 / camera.scale;
  const left = -camera.x / camera.scale - margin;
  const top = -camera.y / camera.scale - margin;
  const right = left + viewport.width / camera.scale + margin * 2;
  const bottom = top + viewport.height / camera.scale + margin * 2;
  return node.x + node.width >= left && node.x <= right && node.y + node.height >= top && node.y <= bottom;
}

export function NotomiNotes({ notebookId, initialPageId }: { notebookId: string; initialPageId?: string }) {
  const userId = useUid();
  const router = useRouter();
  const workspaceChrome = useWorkspaceChrome();
  const subjects = useCollection<Subject>(paths.subjects(getDb(), userId), [userId]);
  const canvasRef = useRef<View>(null);
  const nodesRef = useRef<NoteNode[]>([]);
  const cameraRef = useRef<NoteCamera>({ x: 0, y: 0, scale: 1 });
  const toolRef = useRef<Tool>('pen');
  const colorRef = useRef(PEN_COLORS[0]);
  const sizeRef = useRef(4.5);
  const brushRef = useRef<NoteBrush>('fountain');
  const gestureRef = useRef<ActiveGesture>(null);
  const touchesRef = useRef(new Map<number, Point>());
  const touchBaseRef = useRef<TouchBase | null>(null);
  const selectedRef = useRef<string[]>([]);
  const undoRef = useRef<NoteNode[][]>([]);
  const redoRef = useRef<NoteNode[][]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const touchTapRef = useRef({ fingers: 0, moved: false, startedAt: 0, lastTapAt: 0, lastFingers: 0 });
  const undoActionRef = useRef<() => void>(() => undefined);
  const redoActionRef = useRef<() => void>(() => undefined);
  const dismissHintActionRef = useRef<() => void>(() => undefined);
  const initialPageIdRef = useRef(initialPageId);
  const pageLoadRef = useRef(0);
  const pageEditRevisionRef = useRef(0);
  const notebookMutationRef = useRef(0);
  const hintOpacity = useRef(new Animated.Value(0)).current;

  const [nodes, setNodes] = useState<NoteNode[]>([]);
  const [camera, setCamera] = useState<NoteCamera>({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [penSize, setPenSize] = useState(4.5);
  const [brush, setBrush] = useState<NoteBrush>('fountain');
  const [notebook, setNotebook] = useState<NoteNotebook | null>(null);
  const [pageId, setPageId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [syncState, setSyncState] = useState<'loading' | 'local' | 'syncing' | 'synced' | 'error'>('loading');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [materials, setMaterials] = useState<NoteMaterial[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropDraft, setCropDraft] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    sizeRef.current = penSize;
  }, [penSize]);
  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const stateSnapshot = useCallback(
    (nextNodes = nodesRef.current, nextCamera = cameraRef.current) => ({
      id: pageId,
      title: notebook?.pages.find((page) => page.id === pageId)?.title ?? 'Notes page',
      nodes: nextNodes,
      camera: nextCamera,
      updatedAt: Date.now(),
    }),
    [notebook?.pages, pageId]
  );

  const scheduleCloudSync = useCallback(
    (nextNodes = nodesRef.current, nextCamera = cameraRef.current) => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      setSyncState('local');
      setSyncError(null);
      const snapshot = stateSnapshot(nextNodes, nextCamera);
      syncTimerRef.current = setTimeout(() => {
        setSyncState('syncing');
        void syncNoteCanvasCloud(userId, notebookId, snapshot)
          .then(() => setSyncState('synced'))
          .catch((error) => {
            setSyncError(error instanceof Error ? error.message : String(error));
            setSyncState('error');
          });
      }, 3000);
    },
    [notebookId, stateSnapshot, userId]
  );

  const storeNow = useCallback(
    (nextNodes = nodesRef.current, nextCamera = cameraRef.current) => {
      pageEditRevisionRef.current += 1;
      const snapshot = stateSnapshot(nextNodes, nextCamera);
      void saveNoteCanvasLocal(userId, notebookId, snapshot).catch((error) => {
        setSyncError(error instanceof Error ? error.message : String(error));
        setSyncState('error');
      });
      scheduleCloudSync(nextNodes, nextCamera);
    },
    [notebookId, scheduleCloudSync, stateSnapshot, userId]
  );

  const replaceNodes = useCallback(
    (next: NoteNode[], keepHistory = true) => {
      if (next.length > NOTE_LIMITS.nodesPerPage) {
        setSyncError(`This page has reached its ${NOTE_LIMITS.nodesPerPage.toLocaleString()} object safety limit. Start another page to keep writing smoothly.`);
        setSyncState('error');
        return;
      }
      if (keepHistory) {
        undoRef.current = [...undoRef.current.slice(-49), nodesRef.current];
        redoRef.current = [];
      }
      nodesRef.current = next;
      setNodes(next);
      storeNow(next);
    },
    [storeNow]
  );

  useEffect(() => {
    let active = true;
    setSyncState('loading');
    const initialTarget = initialPageIdRef.current;
    const applyNotebook = (savedNotebook: NoteNotebook) => {
      const target = savedNotebook.pages.some((page) => page.id === initialTarget)
        ? initialTarget!
        : savedNotebook.pages[0]?.id;
      if (!target) throw new Error('This notebook does not have a page yet.');
      setNotebook(savedNotebook);
      setHintVisible(savedNotebook.canvasHintDismissed !== true);
      hintOpacity.setValue(savedNotebook.canvasHintDismissed === true ? 0 : 1);
      setPageId((current) =>
        current && savedNotebook.pages.some((page) => page.id === current) ? current : target
      );
    };

    void (async () => {
      const local = await loadNoteNotebookLocal(userId, notebookId).catch(() => null);
      if (!active) return;
      if (local) applyNotebook(local);

      const remote = await loadNoteNotebook(userId, notebookId);
      if (!active) return;
      if (!remote) {
        if (!local) throw new Error('This notebook could not be found.');
        return;
      }
      if (!local || notebookMutationRef.current === 0) {
        applyNotebook({
          ...remote,
          canvasHintDismissed: remote.canvasHintDismissed === true || local?.canvasHintDismissed === true,
        });
      }
    })()
      .catch((error) => {
        if (!active) return;
        setSyncError(error instanceof Error ? error.message : String(error));
        setSyncState('error');
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [hintOpacity, notebookId, userId]);

  useEffect(() => {
    if (!pageId) return;
    let active = true;
    const loadId = ++pageLoadRef.current;
    pageEditRevisionRef.current = 0;
    setSyncState('loading');
    setSelected([]);
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
    undoRef.current = [];
    redoRef.current = [];
    const blank = blankNoteCanvas(pageId);
    nodesRef.current = blank.nodes;
    cameraRef.current = blank.camera;
    setNodes(blank.nodes);
    setCamera(blank.camera);
    setReady(true);

    const adopt = async (saved: ReturnType<typeof blankNoteCanvas>) => {
      const hydrated = await hydrateNoteAssets(saved.nodes);
      if (!active || pageLoadRef.current !== loadId || pageEditRevisionRef.current !== 0) {
        for (const node of hydrated) {
          if (node.type !== 'stroke' && node.data.previewUrl) URL.revokeObjectURL(node.data.previewUrl);
        }
        return false;
      }
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
      for (const node of hydrated) {
        if (node.type !== 'stroke' && node.data.previewUrl) objectUrlsRef.current.add(node.data.previewUrl);
      }
      nodesRef.current = hydrated;
      cameraRef.current = saved.camera;
      setNodes(hydrated);
      setCamera(saved.camera);
      return true;
    };

    void (async () => {
      // Start cloud reconciliation now, but never await it before exposing the
      // local page. A page without a local record is still immediately usable.
      const reconciledPromise = loadNoteCanvas(userId, notebookId, pageId);
      const local = await loadNoteCanvasLocal(userId, notebookId, pageId).catch(() => null);
      if (local && (await adopt(local))) setSyncState('local');
      else if (active && pageLoadRef.current === loadId) setSyncState('local');

      const reconciled = await reconciledPromise;
      if (await adopt(reconciled)) setSyncState('synced');
    })()
      .catch((error) => {
        if (!active || pageLoadRef.current !== loadId) return;
        setSyncError(error instanceof Error ? error.message : String(error));
        setSyncState('error');
      });
    return () => {
      active = false;
    };
  }, [notebookId, pageId, userId]);

  useEffect(
    () => () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    },
    []
  );

  const updateCamera = useCallback((next: NoteCamera, persist = false) => {
    const safe = { ...next, scale: Math.min(4, Math.max(0.2, next.scale)) };
    cameraRef.current = safe;
    setCamera(safe);
    if (persist) storeNow(nodesRef.current, safe);
  }, [storeNow]);

  const setActivePath = useCallback((id: string, path: string) => {
    if (Platform.OS !== 'web') return;
    document.getElementById(id)?.setAttribute('d', path);
  }, []);

  const dismissBlankHint = useCallback(() => {
    if (!hintVisible) return;
    Animated.timing(hintOpacity, {
      toValue: 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => {
      if (finished) setHintVisible(false);
    });

    if (!notebook || notebook.canvasHintDismissed === true) return;
    notebookMutationRef.current += 1;
    const updated = { ...notebook, canvasHintDismissed: true, updatedAt: Date.now() };
    setNotebook(updated);
    void saveNoteNotebook(userId, updated).catch(() => undefined);
  }, [hintOpacity, hintVisible, notebook, userId]);

  useEffect(() => {
    dismissHintActionRef.current = dismissBlankHint;
  }, [dismissBlankHint]);

  useEffect(() => {
    if (!ready || Platform.OS !== 'web') return;
    const element = canvasRef.current as unknown as HTMLElement | null;
    if (!element) return;

    const local = (event: PointerEvent): Point => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const world = (point: Point): Point => ({
      x: (point.x - cameraRef.current.x) / cameraRef.current.scale,
      y: (point.y - cameraRef.current.y) / cameraRef.current.scale,
    });
    const resetTouchBase = () => {
      touchBaseRef.current = {
        camera: { ...cameraRef.current },
        points: [...touchesRef.current.values()].map((point) => ({ ...point })),
      };
    };
    const drawActive = (points: NotePoint[]) => {
      setActivePath(
        ACTIVE_PATH_ID,
        strokePath(outlineFor(points, sizeRef.current, brushRef.current))
      );
    };
    const eraseAt = (point: Point) => {
      const radius = 14 / cameraRef.current.scale;
      const current = nodesRef.current;
      const next = current.filter((node) => {
        if (node.type !== 'stroke') return true;
        const near = node.data.points.some((sample) =>
          distance(point, { x: node.x + sample[0], y: node.y + sample[1] }) <= radius
        );
        return !near;
      });
      if (next.length !== current.length) {
        nodesRef.current = next;
        setNodes(next);
        const gesture = gestureRef.current;
        if (gesture?.mode === 'erase') gesture.changed = true;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      dismissHintActionRef.current();
      element.setPointerCapture?.(event.pointerId);
      const screen = local(event);

      if (event.pointerType === 'touch') {
        if (touchesRef.current.size === 0) {
          touchTapRef.current = {
            ...touchTapRef.current,
            fingers: 1,
            moved: false,
            startedAt: performance.now(),
          };
        }
        touchesRef.current.set(event.pointerId, screen);
        touchTapRef.current.fingers = Math.max(touchTapRef.current.fingers, touchesRef.current.size);
        resetTouchBase();
        gestureRef.current = null;
        return;
      }

      const point = world(screen);
      const currentTool = toolRef.current;
      if (currentTool === 'pen') {
        const pressure = event.pressure > 0 ? event.pressure : 0.5;
        gestureRef.current = { mode: 'draw', points: [[point.x, point.y, pressure]] };
        drawActive((gestureRef.current as Extract<ActiveGesture, { mode: 'draw' }>).points);
        return;
      }
      if (currentTool === 'eraser') {
        gestureRef.current = { mode: 'erase', before: nodesRef.current, changed: false };
        eraseAt(point);
        return;
      }
      if (currentTool === 'lasso') {
        gestureRef.current = { mode: 'lasso', points: [point] };
        setActivePath(LASSO_PATH_ID, `M${point.x},${point.y}`);
        return;
      }

      const hit = hitNode(nodesRef.current, point);
      if (hit) {
        const ids = selectedRef.current.includes(hit.id) ? selectedRef.current : [hit.id];
        setSelected(ids);
        selectedRef.current = ids;
        const resizeRadius = 26 / cameraRef.current.scale;
        const onResizeHandle =
          hit.type !== 'stroke' &&
          Math.abs(point.x - (hit.x + hit.width)) <= resizeRadius &&
          Math.abs(point.y - (hit.y + hit.height)) <= resizeRadius;
        gestureRef.current = onResizeHandle
          ? {
              mode: 'resize',
              start: point,
              before: nodesRef.current,
              id: hit.id,
              width: hit.width,
              height: hit.height,
            }
          : { mode: 'drag', start: point, before: nodesRef.current, ids };
      } else {
        setSelected([]);
        selectedRef.current = [];
        gestureRef.current = { mode: 'pan', start: screen, camera: { ...cameraRef.current } };
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      event.preventDefault();
      const screen = local(event);

      if (event.pointerType === 'touch') {
        if (!touchesRef.current.has(event.pointerId)) return;
        touchesRef.current.set(event.pointerId, screen);
        const base = touchBaseRef.current;
        const current = [...touchesRef.current.values()];
        if (!base || base.points.length !== current.length) {
          resetTouchBase();
          return;
        }
        if (base.points.some((point, index) => distance(point, current[index] ?? point) > 8)) {
          touchTapRef.current.moved = true;
        }
        if (current.length === 1) {
          updateCamera({
            ...base.camera,
            x: base.camera.x + current[0].x - base.points[0].x,
            y: base.camera.y + current[0].y - base.points[0].y,
          });
        } else if (current.length >= 2) {
          const startDistance = Math.max(20, distance(base.points[0], base.points[1]));
          const currentDistance = distance(current[0], current[1]);
          const startCenter = {
            x: (base.points[0].x + base.points[1].x) / 2,
            y: (base.points[0].y + base.points[1].y) / 2,
          };
          const center = { x: (current[0].x + current[1].x) / 2, y: (current[0].y + current[1].y) / 2 };
          const scale = Math.min(4, Math.max(0.2, base.camera.scale * (currentDistance / startDistance)));
          const anchor = {
            x: (startCenter.x - base.camera.x) / base.camera.scale,
            y: (startCenter.y - base.camera.y) / base.camera.scale,
          };
          updateCamera({ x: center.x - anchor.x * scale, y: center.y - anchor.y * scale, scale });
        }
        return;
      }

      const gesture = gestureRef.current;
      if (!gesture) return;
      const point = world(screen);
      if (gesture.mode === 'draw') {
        const samples = event.getCoalescedEvents?.() ?? [event];
        for (const sample of samples) {
          const samplePoint = world(local(sample));
          const pressure = sample.pressure > 0 ? sample.pressure : 0.5;
          gesture.points.push([samplePoint.x, samplePoint.y, pressure]);
        }
        drawActive(gesture.points);
      } else if (gesture.mode === 'erase') {
        eraseAt(point);
      } else if (gesture.mode === 'lasso') {
        gesture.points.push(point);
        setActivePath(
          LASSO_PATH_ID,
          `M${gesture.points.map((entry) => `${entry.x.toFixed(1)},${entry.y.toFixed(1)}`).join(' L')}`
        );
      } else if (gesture.mode === 'drag') {
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        const ids = new Set(gesture.ids);
        const next = gesture.before.map((node) =>
          ids.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node
        );
        nodesRef.current = next;
        setNodes(next);
      } else if (gesture.mode === 'resize') {
        const dx = point.x - gesture.start.x;
        const ratio = gesture.height / Math.max(1, gesture.width);
        const width = Math.max(80, gesture.width + dx);
        const next = gesture.before.map((node) =>
          node.id === gesture.id ? { ...node, width, height: width * ratio } : node
        );
        nodesRef.current = next;
        setNodes(next);
      } else if (gesture.mode === 'pan') {
        updateCamera({
          ...gesture.camera,
          x: gesture.camera.x + screen.x - gesture.start.x,
          y: gesture.camera.y + screen.y - gesture.start.y,
        });
      }
    };

    const finishPointer = (event: PointerEvent) => {
      event.preventDefault();
      if (event.pointerType === 'touch') {
        touchesRef.current.delete(event.pointerId);
        if (touchesRef.current.size > 0) resetTouchBase();
        else {
          touchBaseRef.current = null;
          const tap = touchTapRef.current;
          const now = performance.now();
          const isGestureTap = !tap.moved && now - tap.startedAt < 320 && (tap.fingers === 2 || tap.fingers === 3);
          if (isGestureTap) {
            const doubleTap = tap.lastFingers === tap.fingers && now - tap.lastTapAt < 480;
            if (doubleTap) {
              if (tap.fingers === 2) undoActionRef.current();
              else redoActionRef.current();
              tap.lastTapAt = 0;
              tap.lastFingers = 0;
            } else {
              tap.lastTapAt = now;
              tap.lastFingers = tap.fingers;
            }
          } else {
            storeNow(nodesRef.current, cameraRef.current);
          }
        }
        return;
      }

      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;
      if (gesture.mode === 'draw') {
        const outline = outlineFor(gesture.points, sizeRef.current, brushRef.current);
        const box = bounds(outline);
        const localOutline = outline.map((point) => [point[0] - box.x, point[1] - box.y]);
        const node: NoteStrokeNode = {
          id: uid('stroke'),
          type: 'stroke',
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          data: {
            path: strokePath(localOutline),
            points: gesture.points.map(([x, y, pressure]) => [x - box.x, y - box.y, pressure]),
            color: colorRef.current,
            size: sizeRef.current,
            brush: brushRef.current,
            opacity: BRUSHES.find((entry) => entry.id === brushRef.current)?.opacity ?? 1,
          },
        };
        setActivePath(ACTIVE_PATH_ID, '');
        replaceNodes([...nodesRef.current, node]);
      } else if (gesture.mode === 'erase' && gesture.changed) {
        undoRef.current = [...undoRef.current.slice(-49), gesture.before];
        redoRef.current = [];
        storeNow(nodesRef.current);
      } else if (gesture.mode === 'lasso') {
        setActivePath(LASSO_PATH_ID, '');
        if (gesture.points.length >= 3) {
          const ids = nodesRef.current.flatMap((node) => {
            const corners = [
              { x: node.x, y: node.y },
              { x: node.x + node.width, y: node.y },
              { x: node.x, y: node.y + node.height },
              { x: node.x + node.width, y: node.y + node.height },
            ];
            return corners.every((corner) => pointInPolygon(corner, gesture.points)) ? [node.id] : [];
          });
          setSelected(ids);
          selectedRef.current = ids;
        }
      } else if (gesture.mode === 'drag' || gesture.mode === 'resize') {
        undoRef.current = [...undoRef.current.slice(-49), gesture.before];
        redoRef.current = [];
        storeNow(nodesRef.current);
      } else if (gesture.mode === 'pan') {
        storeNow(nodesRef.current, cameraRef.current);
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const before = cameraRef.current;
      const anchor = { x: (cursor.x - before.x) / before.scale, y: (cursor.y - before.y) / before.scale };
      const scale = Math.min(4, Math.max(0.2, before.scale * Math.exp(-event.deltaY * 0.0015)));
      updateCamera({ x: cursor.x - anchor.x * scale, y: cursor.y - anchor.y * scale, scale }, true);
    };

    element.addEventListener('pointerdown', onPointerDown, { passive: false });
    element.addEventListener('pointermove', onPointerMove, { passive: false });
    element.addEventListener('pointerup', finishPointer, { passive: false });
    element.addEventListener('pointercancel', finishPointer, { passive: false });
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', finishPointer);
      element.removeEventListener('pointercancel', finishPointer);
      element.removeEventListener('wheel', onWheel);
    };
  }, [ready, replaceNodes, setActivePath, storeNow, updateCamera]);

  const visibleNodes = useMemo(
    () => nodes.filter((node) => visibleNode(node, camera, viewport)),
    [nodes, camera, viewport]
  );

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(nodesRef.current);
    nodesRef.current = previous;
    setNodes(previous);
    setSelected([]);
    storeNow(previous);
  }, [storeNow]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    setSelected([]);
    storeNow(next);
  }, [storeNow]);

  useEffect(() => {
    undoActionRef.current = undo;
    redoActionRef.current = redo;
  }, [redo, undo]);

  const deleteSelection = useCallback(() => {
    const ids = new Set(selectedRef.current);
    if (ids.size === 0) return;
    replaceNodes(nodesRef.current.filter((node) => !ids.has(node.id)));
    setSelected([]);
  }, [replaceNodes]);

  const scaleSelection = useCallback(
    (factor: number) => {
      const ids = new Set(selectedRef.current);
      if (ids.size === 0) return;
      replaceNodes(
        nodesRef.current.map((node) =>
          ids.has(node.id) && node.type !== 'stroke'
            ? { ...node, width: node.width * factor, height: node.height * factor }
            : node
        )
      );
    },
    [replaceNodes]
  );

  const fitAll = useCallback(() => {
    if (nodesRef.current.length === 0) {
      updateCamera({ x: 0, y: 0, scale: 1 }, true);
      return;
    }
    const minX = Math.min(...nodesRef.current.map((node) => node.x));
    const minY = Math.min(...nodesRef.current.map((node) => node.y));
    const maxX = Math.max(...nodesRef.current.map((node) => node.x + node.width));
    const maxY = Math.max(...nodesRef.current.map((node) => node.y + node.height));
    const scale = Math.min(2, Math.max(0.2, Math.min((viewport.width - 80) / (maxX - minX || 1), (viewport.height - 80) / (maxY - minY || 1))));
    updateCamera({
      scale,
      x: (viewport.width - (maxX - minX) * scale) / 2 - minX * scale,
      y: (viewport.height - (maxY - minY) * scale) / 2 - minY * scale,
    }, true);
  }, [updateCamera, viewport]);

  const switchPage = useCallback(
    (nextPageId: string, persistCurrent = true) => {
      if (!nextPageId || nextPageId === pageId) return;
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
      if (persistCurrent) {
        const snapshot = stateSnapshot(nodesRef.current, cameraRef.current);
        void saveNoteCanvasLocal(userId, notebookId, snapshot).catch((error) => {
          setSyncError(error instanceof Error ? error.message : String(error));
          setSyncState('error');
        });
        void syncNoteCanvasCloud(userId, notebookId, snapshot).catch((error) => {
          setSyncError(error instanceof Error ? error.message : String(error));
          setSyncState('error');
        });
      }
      setPageId(nextPageId);
      router.replace(`/knowledge/notes/${notebookId}?page=${nextPageId}` as never);
    },
    [notebookId, pageId, router, stateSnapshot, userId]
  );

  const addPage = useCallback(() => {
    if (!notebook) return;
    if (notebook.pages.length >= NOTE_LIMITS.pagesPerNotebook) {
      setSyncError(`This notebook has reached its ${NOTE_LIMITS.pagesPerNotebook}-page safety limit.`);
      return;
    }
    const now = Date.now();
    const nextPage = {
      id: uid('page'),
      title: `Page ${notebook.pages.length + 1}`,
      order: notebook.pages.length,
      createdAt: now,
      updatedAt: now,
    };
    const nextNotebook = {
      ...notebook,
      pages: [...notebook.pages, nextPage],
      updatedAt: now,
    };
    notebookMutationRef.current += 1;
    setNotebook(nextNotebook);
    const blank = { ...blankNoteCanvas(nextPage.id), title: nextPage.title };
    void saveNoteCanvasLocal(userId, notebookId, blank).catch((error) => {
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncState('error');
    });
    void saveNoteNotebook(userId, nextNotebook).catch((error) => {
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncState('error');
    });
    switchPage(nextPage.id);
  }, [notebook, notebookId, switchPage, userId]);

  const deletePage = useCallback(() => {
    if (!notebook || notebook.pages.length <= 1) return;
    const currentPage = notebook.pages.find((page) => page.id === pageId);
    if (!currentPage) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete ${currentPage.title}?`)) return;
    const pages = notebook.pages
      .filter((page) => page.id !== pageId)
      .map((page, index) => ({ ...page, order: index }));
    const nextNotebook = { ...notebook, pages, updatedAt: Date.now() };
    const nextPageId = pages[Math.max(0, Math.min(pages.length - 1, currentPage.order - 1))].id;
    notebookMutationRef.current += 1;
    setNotebook(nextNotebook);
    switchPage(nextPageId, false);
    void Promise.all([
      saveNoteNotebook(userId, nextNotebook),
      deleteNotePageLocal(userId, notebookId, pageId),
    ]).catch((error) => {
      setSyncError(error instanceof Error ? error.message : String(error));
      setSyncState('error');
    });
  }, [notebook, notebookId, pageId, switchPage, userId]);

  const selectedAsset = useMemo(() => {
    if (selected.length !== 1) return null;
    const node = nodes.find((entry) => entry.id === selected[0]);
    return node && node.type !== 'stroke' ? node : null;
  }, [nodes, selected]);

  const openCrop = useCallback(() => {
    if (!selectedAsset) return;
    setCropDraft(selectedAsset.data.crop ?? { x: 0, y: 0, width: 1, height: 1 });
    setCropOpen(true);
  }, [selectedAsset]);

  const trimCrop = useCallback((edge: 'left' | 'right' | 'top' | 'bottom', amount: number) => {
    setCropDraft((current) => {
      const next = { ...current };
      if (edge === 'left') {
        const change = Math.max(-next.x, Math.min(amount, next.width - 0.1));
        next.x += change;
        next.width -= change;
      } else if (edge === 'right') {
        next.width = Math.max(0.1, Math.min(1 - next.x, next.width - amount));
      } else if (edge === 'top') {
        const change = Math.max(-next.y, Math.min(amount, next.height - 0.1));
        next.y += change;
        next.height -= change;
      } else {
        next.height = Math.max(0.1, Math.min(1 - next.y, next.height - amount));
      }
      return next;
    });
  }, []);

  const applyCrop = useCallback(() => {
    if (!selectedAsset) return;
    const old = selectedAsset.data.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    replaceNodes(
      nodesRef.current.map((node) =>
        node.id === selectedAsset.id && node.type !== 'stroke'
          ? {
              ...node,
              width: Math.max(80, node.width * (cropDraft.width / old.width)),
              height: Math.max(80, node.height * (cropDraft.height / old.height)),
              data: { ...node.data, crop: cropDraft },
            }
          : node
      )
    );
    setCropOpen(false);
  }, [cropDraft, replaceNodes, selectedAsset]);

  const appendPages = useCallback(
    async (pages: RenderedMaterialPage[], title: string, sourceFileKey?: string | null) => {
      const currentMaterialCount = nodesRef.current.filter((node) => node.type !== 'stroke').length;
      if (currentMaterialCount + pages.length > NOTE_LIMITS.materialNodesPerPage) {
        throw new Error(
          `A Notes page can hold up to ${NOTE_LIMITS.materialNodesPerPage} imported PDF or image pages. Add another notebook page before importing more.`
        );
      }
      const baseX = (-cameraRef.current.x + 80) / cameraRef.current.scale;
      const baseY = (-cameraRef.current.y + 120) / cameraRef.current.scale;
      const added: NoteAssetNode[] = [];
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const assetKey = `${userId}:${notebookId}:${pageId}:${uid('asset')}`;
        await saveNoteAsset(assetKey, page.blob);
        const previewUrl = URL.createObjectURL(page.blob);
        objectUrlsRef.current.add(previewUrl);
        const width = Math.min(440, page.width);
        const height = width * (page.height / page.width);
        added.push({
          id: uid(page.pageNumber ? 'pdf' : 'image'),
          type: page.pageNumber ? 'pdf_page' : 'image',
          x: baseX + (index % 3) * 480,
          y: baseY + Math.floor(index / 3) * (height + 48),
          width,
          height,
          data: {
            assetKey,
            previewUrl,
            sourceFileKey: sourceFileKey ?? null,
            pageNumber: page.pageNumber,
            title: page.pageNumber ? `${title} · Page ${page.pageNumber}` : title,
          },
        });
      }
      replaceNodes([...nodesRef.current, ...added]);
      setSelected(added.map((node) => node.id));
      setTool('select');
    },
    [notebookId, pageId, replaceNodes, userId]
  );

  const importBlob = useCallback(
    async (blob: Blob, title: string, sourceFileKey?: string | null) => {
      setImporting(true);
      setImportError(null);
      setImportProgress('Preparing material');
      try {
        const availableSlots = NOTE_LIMITS.materialNodesPerPage - nodesRef.current.filter((node) => node.type !== 'stroke').length;
        if (availableSlots <= 0) throw new Error('This page has reached its imported-material limit. Add another notebook page.');
        const pages = await renderMaterial(
          blob,
          (done, total) => setImportProgress(`Rendering page ${done} of ${total}`),
          availableSlots
        );
        await appendPages(pages, title, sourceFileKey);
        setMaterialOpen(false);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      } finally {
        setImporting(false);
        setImportProgress('');
      }
    },
    [appendPages]
  );

  const pickDeviceFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      if (result.assets.length > 5) throw new Error('Choose up to 5 files at a time for an iPad Notes page.');
      for (const asset of result.assets) {
        if ((asset.size ?? 0) > NOTE_LIMITS.localFileBytes) {
          throw new Error(`${asset.name} is larger than the 25 MB per-file safety limit.`);
        }
        let source: Blob;
        if (asset.file) source = asset.file;
        else source = await fetch(asset.uri).then((response) => response.blob());
        const blob = source.type
          ? source
          : new Blob([await source.arrayBuffer()], { type: asset.mimeType ?? 'application/octet-stream' });
        await importBlob(blob, asset.name);
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [importBlob]);

  /**
   * Files chosen through Google's own picker.
   *
   * The picked id is stored as the node's source key, so a board opened on
   * another device rehydrates its pages straight from Drive — the same route
   * course materials already take, with a different origin.
   */
  const pickDriveFiles = useCallback(async () => {
    setImportError(null);
    try {
      const picked = await pickFromDrive();
      for (const file of picked) {
        await importBlob(await fetchDriveBlob(file.fileId), file.name, driveKey(file.fileId));
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [importBlob]);

  const openMaterials = useCallback(() => {
    setMaterialOpen(true);
    setImportError(null);
    setMaterialsLoading(true);
    void listNoteMaterials(userId, subjects.data)
      .then(setMaterials)
      .catch((error) => setImportError(error instanceof Error ? error.message : String(error)))
      .finally(() => setMaterialsLoading(false));
  }, [subjects.data, userId]);

  const importExisting = useCallback(
    async (material: NoteMaterial) => {
      try {
        await importBlob(
          await materialBlob(material),
          material.document.title || material.document.fileName,
          material.document.r2FileKey
        );
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      }
    },
    [importBlob]
  );

  const exportBoard = useCallback(async (format: 'png' | 'pdf') => {
    const current = nodesRef.current;
    if (current.length === 0) return;
    const minX = Math.min(...current.map((node) => node.x));
    const minY = Math.min(...current.map((node) => node.y));
    const maxX = Math.max(...current.map((node) => node.x + node.width));
    const maxY = Math.max(...current.map((node) => node.y + node.height));
    const naturalWidth = Math.max(1, maxX - minX + 64);
    const naturalHeight = Math.max(1, maxY - minY + 64);
    const scale = Math.min(2, 4096 / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(naturalWidth * scale);
    canvas.height = Math.ceil(naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#FAF9F5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.translate(-minX + 32, -minY + 32);

    for (const node of current) {
      if (node.type === 'stroke') {
        context.save();
        context.translate(node.x, node.y);
        context.fillStyle = node.data.color;
        context.globalAlpha = node.data.opacity ?? 1;
        context.fill(new Path2D(node.data.path));
        context.restore();
      } else if (node.data.previewUrl) {
        const image = new Image();
        image.src = node.data.previewUrl;
        await image.decode();
        const crop = node.data.crop ?? { x: 0, y: 0, width: 1, height: 1 };
        context.drawImage(
          image,
          image.naturalWidth * crop.x,
          image.naturalHeight * crop.y,
          image.naturalWidth * crop.width,
          image.naturalHeight * crop.height,
          node.x,
          node.y,
          node.width,
          node.height
        );
      }
    }

    const imageUrl = canvas.toDataURL('image/png');
    if (format === 'pdf') {
      const { jsPDF } = await import('jspdf');
      const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
      const pdf = new jsPDF({ orientation, unit: 'px', format: [canvas.width, canvas.height] });
      pdf.addImage(imageUrl, 'PNG', 0, 0, canvas.width, canvas.height);
      pdf.save('notomi-notes.pdf');
    } else {
      const anchor = document.createElement('a');
      anchor.href = imageUrl;
      anchor.download = 'notomi-notes.png';
      anchor.click();
    }
    setExportOpen(false);
  }, []);

  if (Platform.OS !== 'web') {
    return (
      <View className="flex-1 items-center justify-center bg-paper p-6">
        <Notice title="Open Notes in Safari" body="Apple Pencil input and local PDF rendering use the browser Pointer Events and Canvas APIs." />
      </View>
    );
  }

  if (!ready) {
    return <View className="flex-1 items-center justify-center bg-paper"><Loading label="Opening your local canvas…" /></View>;
  }

  if (!notebook) {
    return (
      <View className="flex-1 items-center justify-center bg-paper p-6">
        <Notice title="Notebook unavailable" body={syncError ?? 'Return to your notebook shelf and choose another notebook.'} />
        <View className="mt-4">
          <Button label="Back to notebooks" icon="arrow-left" onPress={() => router.replace('/knowledge/notes')} />
        </View>
      </View>
    );
  }

  const gridSize = 24 * camera.scale;
  const selectedSet = new Set(selected);
  const currentPageIndex = Math.max(0, notebook.pages.findIndex((page) => page.id === pageId));
  const currentPage = notebook.pages[currentPageIndex];

  return (
    <View
      nativeID="notomi-notes-canvas"
      className="notes-canvas relative min-h-0 flex-1 overflow-hidden bg-paper"
      style={[
        NOTE_STYLE,
        {
          backgroundImage: 'radial-gradient(circle, rgba(111,106,95,0.26) 1px, transparent 1.2px)',
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        } as unknown as ViewStyle,
      ]}
      onLayout={(event: LayoutChangeEvent) =>
        setViewport({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
      }
    >
      <View ref={canvasRef} nativeID="notomi-notes-gesture-surface" style={StyleSheet.absoluteFill} />
      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
        <G transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          {visibleNodes.map((node) => {
            const crop = node.type === 'stroke'
              ? null
              : node.data.crop ?? { x: 0, y: 0, width: 1, height: 1 };
            const clipId = `note-clip-${node.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
            return (
              <G key={node.id} transform={`translate(${node.x} ${node.y})`}>
                {node.type === 'stroke' ? (
                  <Path d={node.data.path} fill={node.data.color} fillOpacity={node.data.opacity ?? 1} />
                ) : node.data.previewUrl && crop ? (
                  <>
                    <Defs>
                      <ClipPath id={clipId}>
                        <Rect width={node.width} height={node.height} rx={6} />
                      </ClipPath>
                    </Defs>
                    <G clipPath={`url(#${clipId})`}>
                      <SvgImage
                        href={node.data.previewUrl}
                        x={-(crop.x / crop.width) * node.width}
                        y={-(crop.y / crop.height) * node.height}
                        width={node.width / crop.width}
                        height={node.height / crop.height}
                        preserveAspectRatio="none"
                      />
                    </G>
                  </>
                ) : (
                  <Rect width={node.width} height={node.height} rx={12} fill="#FFFFFF" stroke="#E7E5E4" />
                )}
                {selectedSet.has(node.id) ? (
                  <>
                    <Rect
                      x={-5}
                      y={-5}
                      width={node.width + 10}
                      height={node.height + 10}
                      rx={8}
                      fill="none"
                      stroke="#B4552D"
                      strokeWidth={2 / camera.scale}
                      strokeDasharray={`${8 / camera.scale} ${5 / camera.scale}`}
                    />
                    {node.type !== 'stroke' ? (
                      <Rect
                        x={node.width - 8 / camera.scale}
                        y={node.height - 8 / camera.scale}
                        width={16 / camera.scale}
                        height={16 / camera.scale}
                        rx={4 / camera.scale}
                        fill="#B4552D"
                      />
                    ) : null}
                  </>
                ) : null}
              </G>
            );
          })}
          <Path
            id={ACTIVE_PATH_ID}
            d=""
            fill={color}
            fillOpacity={BRUSHES.find((entry) => entry.id === brush)?.opacity ?? 1}
          />
          <Path
            id={LASSO_PATH_ID}
            d=""
            fill="rgba(180,85,45,0.08)"
            stroke="#B4552D"
            strokeWidth={1.5 / camera.scale}
            strokeDasharray={`${7 / camera.scale} ${5 / camera.scale}`}
          />
        </G>
      </Svg>

      {nodes.length === 0 && hintVisible ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { opacity: hintOpacity, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
          ]}
        >
          <View className="max-w-sm items-center gap-2 rounded-2xl border border-line bg-surface/90 px-6 py-5">
            <Icon name="pen-tool" size={22} color="#B4552D" />
            <Text className="text-center font-heading text-base font-semibold text-ink">Blank page ready</Text>
            <Text className="text-center text-xs leading-5 text-muted">
              Apple Pencil draws. Fingers pan and pinch. Two-finger double-tap undoes; three-finger double-tap redoes.
            </Text>
          </View>
        </Animated.View>
      ) : null}

      <View
        pointerEvents="box-none"
        nativeID="notomi-notes-ui-toolbar"
        className="absolute left-3 right-3 top-3 z-20 items-center"
      >
        <View
          className="max-w-full flex-row flex-wrap items-center justify-center gap-1 rounded-2xl border border-white/60 bg-surface/90 p-1.5 shadow"
          style={{ backdropFilter: 'blur(18px)' } as unknown as ViewStyle}
        >
          <ToolButton
            label="Back to notebooks"
            icon="arrow-left"
            onPress={() => router.replace('/knowledge/notes')}
          />
          <ToolButton
            label={workspaceChrome.hidden ? 'Show navigation' : 'Hide navigation'}
            icon={workspaceChrome.hidden ? 'panel-left-open' : 'panel-left-close'}
            active={workspaceChrome.hidden}
            onPress={workspaceChrome.toggle}
          />
          <ToolbarDivider />
          {TOOLS.map((entry) => (
            <ToolButton
              key={entry.id}
              label={entry.label}
              icon={entry.icon}
              active={tool === entry.id}
              onPress={() => setTool(entry.id)}
            />
          ))}
          <ToolbarDivider />
          <ToolButton label="Undo" icon="corner-down-left" disabled={undoRef.current.length === 0} onPress={undo} />
          <ToolButton label="Redo" icon="corner-down-right" disabled={redoRef.current.length === 0} onPress={redo} />
          <ToolButton label="Fit canvas" icon="crosshair" onPress={fitAll} />
          <ToolbarDivider />
          <ToolButton label="Add page" icon="file-plus" onPress={() => void addPage()} />
          <ToolButton label="Import material" icon="image" onPress={openMaterials} />
          <ToolButton label="Export" icon="download" onPress={() => setExportOpen(true)} />
        </View>

        {tool === 'pen' ? (
          <View className="mt-2 max-w-full flex-row flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/60 bg-surface/90 px-3 py-2 shadow">
            {BRUSHES.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityLabel={entry.label}
                accessibilityState={{ selected: brush === entry.id }}
                onPress={() => {
                  setBrush(entry.id);
                  setPenSize(entry.size);
                }}
                className={`h-8 w-8 items-center justify-center rounded-lg ${brush === entry.id ? 'bg-ink' : 'bg-sand'}`}
              >
                <Icon name={entry.icon} size={15} color={brush === entry.id ? '#FFFFFF' : '#6F6A5F'} />
              </Pressable>
            ))}
            <ToolbarDivider />
            {PEN_COLORS.map((entry) => (
              <Pressable
                key={entry}
                accessibilityRole="button"
                accessibilityLabel={`Use ${entry} ink`}
                accessibilityState={{ selected: color === entry }}
                onPress={() => setColor(entry)}
                className={`h-6 w-6 items-center justify-center rounded-full ${color === entry ? 'border-2 border-accent' : ''}`}
              >
                <View className="h-4 w-4 rounded-full" style={{ backgroundColor: entry }} />
              </Pressable>
            ))}
            <ToolbarDivider />
            {[3, 4.5, 7].map((entry) => (
              <Pressable
                key={entry}
                accessibilityRole="button"
                accessibilityLabel={`${entry} point pen`}
                accessibilityState={{ selected: penSize === entry }}
                onPress={() => setPenSize(entry)}
                className={`h-7 w-7 items-center justify-center rounded-lg ${penSize === entry ? 'bg-ink' : 'bg-sand'}`}
              >
                <View className="rounded-full bg-accent" style={{ width: entry + 2, height: entry + 2 }} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <View className="mt-2 flex-row items-center gap-1 rounded-full border border-white/60 bg-surface/90 p-1.5 shadow">
          <ToolButton
            label="Previous page"
            icon="chevron-left"
            disabled={currentPageIndex === 0}
            onPress={() => switchPage(notebook.pages[currentPageIndex - 1]?.id)}
          />
          <View className="min-w-[120px] max-w-[220px] px-2">
            <Text className="text-center text-xs font-semibold text-ink" numberOfLines={1}>
              {notebook.title} · {currentPage?.title ?? `Page ${currentPageIndex + 1}`}
            </Text>
          </View>
          <ToolButton
            label="Next page"
            icon="chevron-right"
            disabled={currentPageIndex >= notebook.pages.length - 1}
            onPress={() => switchPage(notebook.pages[currentPageIndex + 1]?.id)}
          />
          <ToolButton label="Add page" icon="plus" onPress={() => void addPage()} />
          <ToolButton
            label="Delete page"
            icon="trash-2"
            danger
            disabled={notebook.pages.length <= 1}
            onPress={() => void deletePage()}
          />
        </View>
      </View>

      <View pointerEvents="none" className="absolute bottom-3 left-3 rounded-full border border-line bg-surface/90 px-3 py-1.5">
        <Text className={`text-[11px] font-semibold ${syncState === 'error' ? 'text-rose' : 'text-muted'}`}>
          {syncState === 'loading'
            ? 'Opening local canvas'
            : syncState === 'syncing'
              ? 'Backing up'
              : syncState === 'synced'
                ? 'Saved locally and backed up'
                : syncState === 'error'
                  ? 'Saved locally · Cloud backup needs attention'
                  : 'Saved on this device'}
        </Text>
      </View>

      <View pointerEvents="none" className="absolute bottom-3 right-3 rounded-full border border-line bg-surface/90 px-3 py-1.5">
        <Text className="text-[11px] font-semibold text-muted">{Math.round(camera.scale * 100)}%</Text>
      </View>

      {selected.length > 0 ? (
        <View
          nativeID="notomi-notes-ui-selection"
          className="absolute bottom-14 left-0 right-0 z-20 items-center"
          pointerEvents="box-none"
        >
          <View className="flex-row items-center gap-1 rounded-2xl border border-line bg-surface p-1.5 shadow">
            <Text className="px-2 text-xs font-semibold text-muted">{selected.length} selected</Text>
            <ToolButton label="Make smaller" icon="minus" onPress={() => scaleSelection(0.9)} />
            <ToolButton label="Make larger" icon="zoom-in" onPress={() => scaleSelection(1.1)} />
            {selectedAsset ? <ToolButton label="Crop material" icon="crop" onPress={openCrop} /> : null}
            <ToolButton label="Delete selection" icon="trash-2" danger onPress={deleteSelection} />
          </View>
        </View>
      ) : null}

      {syncError ? (
        <View pointerEvents="box-none" className="absolute bottom-14 left-3 z-10 max-w-sm">
          <Notice title="Cloud backup paused" body={syncError} />
        </View>
      ) : null}

      <Sheet visible={materialOpen} onClose={() => setMaterialOpen(false)} title="Import material" icon="image">
        <Text className="text-sm leading-5 text-muted">
          Import from this iPad even when the course Library is empty. PDFs are split into movable pages locally.
        </Text>
        <Button
          label="Choose PDF or image from this device"
          icon="file-plus"
          variant="secondary"
          disabled={importing}
          onPress={() => void pickDeviceFiles()}
        />
        {isDriveConfigured() ? (
          <Button
            label="Import from Google Drive"
            icon="upload-cloud"
            variant="secondary"
            disabled={importing}
            onPress={() => void pickDriveFiles()}
          />
        ) : null}
        {importing ? <Loading label={importProgress || 'Importing material…'} /> : null}
        {importError ? <Notice title="Material could not be imported" body={importError} /> : null}
        <View className="gap-2 border-t border-line pt-4">
          <Text className="text-sm font-semibold text-ink">Course materials</Text>
          <Text className="text-xs leading-4 text-muted">PDFs and images already stored in your Knowledge folders.</Text>
          {materialsLoading ? (
            <Loading label="Finding course materials…" />
          ) : materials.length === 0 ? (
            <Text className="text-sm text-subtle">No saved course materials yet. Use the device button above to choose a PDF or image directly.</Text>
          ) : (
            materials.map((material) => (
              <Pressable
                key={`${material.subjectId}-${material.document.id}`}
                accessibilityRole="button"
                disabled={importing}
                onPress={() => void importExisting(material)}
                className="flex-row items-center gap-3 rounded-xl border border-line bg-paper p-3"
              >
                <View className="h-9 w-9 items-center justify-center rounded-lg bg-sand">
                  <Icon name={/pdf/i.test(material.document.mimeType) ? 'file-text' : 'image'} size={16} color="#6F6A5F" />
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-semibold text-ink" numberOfLines={1}>{material.document.title || material.document.fileName}</Text>
                  <Text className="text-xs text-subtle" numberOfLines={1}>{material.subjectName}</Text>
                </View>
                <Icon name="plus" size={16} color="#18181B" />
              </Pressable>
            ))
          )}
        </View>
      </Sheet>

      <Sheet
        visible={cropOpen}
        onClose={() => setCropOpen(false)}
        title="Crop material"
        icon="crop"
        footer={
          <View className="w-full flex-row justify-end gap-2">
            <Button
              label="Reset"
              variant="ghost"
              onPress={() => setCropDraft({ x: 0, y: 0, width: 1, height: 1 })}
            />
            <Button label="Apply crop" icon="crop" onPress={applyCrop} />
          </View>
        }
      >
        <Text className="text-sm leading-5 text-muted">
          Trim each edge in five-percent steps. The original local image remains intact, so Reset restores it at any time.
        </Text>
        <View className="rounded-xl border border-line bg-paper p-4">
          <Text className="text-center text-xs font-semibold text-muted">
            Visible area: {Math.round(cropDraft.width * 100)}% × {Math.round(cropDraft.height * 100)}%
          </Text>
        </View>
        <CropRow label="Left edge" onRestore={() => trimCrop('left', -0.05)} onTrim={() => trimCrop('left', 0.05)} />
        <CropRow label="Right edge" onRestore={() => trimCrop('right', -0.05)} onTrim={() => trimCrop('right', 0.05)} />
        <CropRow label="Top edge" onRestore={() => trimCrop('top', -0.05)} onTrim={() => trimCrop('top', 0.05)} />
        <CropRow label="Bottom edge" onRestore={() => trimCrop('bottom', -0.05)} onTrim={() => trimCrop('bottom', 0.05)} />
      </Sheet>

      <Sheet visible={exportOpen} onClose={() => setExportOpen(false)} title="Export Notomi Notes" icon="download">
        <Text className="text-sm leading-5 text-muted">Everything is rendered on this device. No document bytes are sent to an external service.</Text>
        <Button label="Download PNG" icon="image" onPress={() => void exportBoard('png')} disabled={nodes.length === 0} />
        <Button label="Download PDF" icon="download" variant="secondary" onPress={() => void exportBoard('pdf')} disabled={nodes.length === 0} />
      </Sheet>
    </View>
  );
}

function ToolButton({
  label,
  icon,
  active = false,
  danger = false,
  disabled = false,
  onPress,
}: {
  label: string;
  icon: IconName;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`h-9 w-9 items-center justify-center rounded-xl ${active ? 'bg-ink' : danger ? 'bg-rose-soft' : 'bg-transparent'} ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon name={icon} size={17} color={active ? '#FFFFFF' : danger ? '#B0443E' : '#6F6A5F'} />
    </Pressable>
  );
}

function ToolbarDivider() {
  return <View className="mx-1 h-6 w-px bg-line" />;
}

function CropRow({
  label,
  onRestore,
  onTrim,
}: {
  label: string;
  onRestore: () => void;
  onTrim: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <Text className="flex-1 text-sm font-medium text-ink">{label}</Text>
      <Button label="Restore" icon="plus" size="sm" variant="secondary" onPress={onRestore} />
      <Button label="Trim" icon="minus" size="sm" variant="secondary" onPress={onTrim} />
    </View>
  );
}
