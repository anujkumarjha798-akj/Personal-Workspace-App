// Fullscreen whiteboard editor overlay. Opens over the whole viewport (the
// toolbar stays visible), edits a DiagramData document, and streams every
// committed change back through `onCommit` so the existing autosave persists
// it like any other note content.
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  MousePointer2, Hand, Minus, Pencil, Type as TypeIcon, Image as ImageIcon,
  Shapes, Undo2, Redo2, Grid3x3, Magnet, ZoomIn, ZoomOut, Maximize2, X, Copy,
  Trash2, ArrowRight, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown,
  RotateCcw, Bold, Italic,
} from 'lucide-react';
import type { DObj, DRichSeg, ObjStyleDefaults, ShapeKind } from './types';
import {
  applyDefaults, isConnector, loadDiagram, newObjId, serializeDiagram,
} from './types';
import {
  boxesIntersect, connectorEndPoint, connectorPolyline, distToSegment, estimateTextHeight, findShapeUnder, nearestSide,
  objectsBBox, objBBox, pickObject, rotatePoint, screenToWorld,
  sideMidpoint, type BBox, type ConnectorEnd, type Side,
} from './geometry';
import { ObjectNode } from './DiagramCanvas';
import { IconPicker, type SimpleIcon } from './IconPicker';
import { api, attachmentExtFromMime } from '../../services/api';

type Tool = 'select' | 'hand' | ShapeKind | 'arrow' | 'line' | 'pen' | 'text';
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface Cam { tx: number; ty: number; scale: number }

// Session-level clipboard shared across diagram instances (requirement #34) —
// deliberately separate from the system/Tiptap clipboard.
let clipboardObjects: DObj[] | null = null;

const GRID_SIZE = 10;
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const SHAPE_MENU: { kind: ShapeKind; label: string }[] = [
  { kind: 'rect', label: 'Rectangle · process' },
  { kind: 'roundrect', label: 'Rounded rectangle' },
  { kind: 'terminator', label: 'Start / End' },
  { kind: 'ellipse', label: 'Circle / Ellipse' },
  { kind: 'diamond', label: 'Diamond · decision' },
  { kind: 'triangle', label: 'Triangle' },
  { kind: 'star', label: 'Star' },
  { kind: 'parallelogram', label: 'Input / Output' },
  { kind: 'cylinder', label: 'Database' },
  { kind: 'doc', label: 'Document' },
  { kind: 'preprocess', label: 'Predefined process' },
];

const FILL_SWATCHES: { value: string; label: string }[] = [
  { value: '#8a8a8a', label: 'Gray' },
  { value: '#e0554d', label: 'Red' },
  { value: '#e08a3c', label: 'Orange' },
  { value: '#e6c84a', label: 'Yellow' },
  { value: '#58b558', label: 'Green' },
  { value: '#3aa6a0', label: 'Teal' },
  { value: '#4a7de0', label: 'Blue' },
  { value: '#9a5ce0', label: 'Purple' },
  { value: '#f2f2f2', label: 'White' },
  { value: '#262626', label: 'Black' },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function isShapeLike(o: DObj): boolean {
  return !isConnector(o.type) && o.type !== 'pen' && o.type !== 'image';
}

function shiftPatch(o: DObj, dx: number, dy: number): Partial<DObj> {
  if (isConnector(o.type)) {
    const patch: Partial<DObj> = {};
    if (!o.fromId) { patch.x = o.x + dx; patch.y = o.y + dy; }
    if (!o.toId) { patch.x2 = (o.x2 ?? o.x) + dx; patch.y2 = (o.y2 ?? o.y) + dy; }
    // Free bend points ride along with the line.
    if (o.waypoints?.length) {
      patch.waypoints = o.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    return patch;
  }
  return { x: o.x + dx, y: o.y + dy };
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 240 });
    img.onerror = () => resolve({ w: 320, h: 240 });
    img.src = url;
  });
}

function normalizeHex(c: string | null | undefined, fallback: string): string {
  if (!c) return fallback;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}

// ---- rich-text paste (note editor → whiteboard) ------------------------------
// The note editor copies browser HTML; we flatten it into formatting RUNS
// (bold / italic / color / size) that diagram text objects can render, while
// keeping a plain string for editing and search.

interface RunFmt { b: boolean; i: boolean; c: string | null; s: number | null }
interface Run extends RunFmt { t: string }

interface ParsedPaste {
  plain: string;
  rich: DRichSeg[];
  hasFmt: boolean;
  fontSize: number | null;
  color: string | null;
}

const LEGACY_FONT_SIZE: Record<string, number> = { '1': 10, '2': 13, '3': 16, '4': 18, '5': 24, '6': 32, '7': 48 };
const HEADING_SIZES = [26, 24, 20, 18, 16, 14];

function normalizeColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const m = v.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) {
    const hex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return null;
}

function collectRuns(node: Node, fmt: RunFmt, out: Run[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent || '';
    if (t) out.push({ ...fmt, t });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return;

  const next: RunFmt = { ...fmt };
  let blockBreak = false;

  if (tag === 'BR') {
    out.push({ ...next, t: '\n' });
    return;
  }
  if (tag === 'B' || tag === 'STRONG' || tag === 'TH') next.b = true;
  if (tag === 'I' || tag === 'EM') next.i = true;
  if (/^H[1-6]$/.test(tag)) {
    next.b = true;
    next.s = HEADING_SIZES[Number(tag[1]) - 1] ?? 16;
    blockBreak = true;
  }
  const styleAttr = el.getAttribute('style');
  if (styleAttr) {
    for (const decl of styleAttr.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const val = decl.slice(idx + 1).trim();
      if (!val) continue;
      if ((prop === 'font-weight' && /bold|[6-9]00/.test(val))) next.b = true;
      if (prop === 'font-style' && val.includes('italic')) next.i = true;
      if (prop === 'color') next.c = normalizeColor(val) ?? next.c;
      if (prop === 'font-size') {
        const px = parseFloat(val);
        if (Number.isFinite(px)) next.s = Math.max(8, Math.min(72, px));
      }
    }
  }
  if (tag === 'FONT' && el.getAttribute('color')) next.c = normalizeColor(el.getAttribute('color')!) ?? next.c;
  if (tag === 'FONT' && el.getAttribute('size')) next.s = LEGACY_FONT_SIZE[el.getAttribute('size')!] ?? next.s;

  el.childNodes.forEach((child) => collectRuns(child, next, out));

  // Block boundaries become line breaks so paragraphs survive the trip.
  if (blockBreak
    || ['P', 'DIV', 'LI', 'UL', 'OL', 'TR', 'TABLE', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE'].includes(tag)) {
    out.push({ ...next, t: '\n' });
  }
}

export function htmlToRich(html: string): ParsedPaste | null {
  if (!html) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html.slice(0, 300_000), 'text/html');
  } catch {
    return null;
  }
  const runs: Run[] = [];
  doc.body?.childNodes.forEach((child) => collectRuns(child, { b: false, i: false, c: null, s: null }, runs));

  // Merge adjacent identical-format runs; collapse blank lines.
  const segs: DRichSeg[] = [];
  for (const r of runs) {
    const t = r.t.replace(/\n{2,}/g, '\n');
    if (!t) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.b === !!r.b && prev.i === !!r.i && prev.c === r.c && prev.s === (r.s ?? undefined)) {
      prev.t += t;
    } else {
      const seg: DRichSeg = { t };
      if (r.b) seg.b = true;
      if (r.i) seg.i = true;
      if (r.c) seg.c = r.c;
      if (r.s != null) seg.s = r.s;
      segs.push(seg);
    }
  }
  while (segs.length && !segs[0].t.trim()) segs.shift();
  while (segs.length && !segs[segs.length - 1].t.trim()) segs.pop();
  if (!segs.length) return null;

  // Hard caps so a giant page copy cannot explode an object.
  const capped = segs.slice(0, 400);
  let total = 0;
  for (const s of capped) {
    if (total + s.t.length > 5000) {
      s.t = s.t.slice(0, Math.max(0, 5000 - total));
      break;
    }
    total += s.t.length;
  }

  // Object-level defaults: most-used (char-weighted) size & colour.
  const tally = new Map<string, number>();
  const bump = (key: string | null, weight: number) => {
    if (!key) return;
    tally.set(key, (tally.get(key) ?? 0) + weight);
  };
  let fontSize: number | null = null;
  let color: string | null = null;
  for (const s of capped) {
    bump(s.s != null ? String(s.s) : null, s.t.length);
    bump(s.c ?? null, s.t.length);
  }
  let bestN = 0;
  for (const [key, n] of tally) {
    if (n <= bestN) continue;
    bestN = n;
    if (/^\d+$/.test(key)) fontSize = Number(key);
    else color = key;
  }
  const hasFmt = capped.some((s) => s.b || s.i || s.c || s.s != null);

  return { plain: capped.map((s) => s.t).join(''), rich: capped, hasFmt, fontSize, color };
}

// New text must be readable on the CURRENT theme's canvas: near-white on the
// dark board, near-black on the light one.
function defaultTextColor(): string {
  return document.documentElement.dataset.theme === 'light' ? '#262626' : '#e6e6e6';
}

function hintFor(tool: Tool): string {
  if (tool === 'select') return 'Drag = select · double-click shape = text · Space/middle-drag pans';
  if (tool === 'hand') return 'Drag pans · Ctrl+scroll zooms';
  if (tool === 'arrow' || tool === 'line') return 'Draw to connect · Shift = right-angle · drag ends to re-wire · drag middle to bend · double-click for label';
  if (tool === 'pen') return 'Draw freely · tool stays active';
  if (tool === 'text') return 'Click or double-click anywhere · type right away · Esc / click outside to finish';
  return 'Tool stays active — drag or click to place shapes';
}

interface HandleSet { [k: string]: { cx: number; cy: number } }

function handlePositions(o: DObj): HandleSet {
  const { x, y, w, h } = o;
  return {
    nw: { cx: x, cy: y },
    n: { cx: x + w / 2, cy: y },
    ne: { cx: x + w, cy: y },
    e: { cx: x + w, cy: y + h / 2 },
    se: { cx: x + w, cy: y + h },
    s: { cx: x + w / 2, cy: y + h },
    sw: { cx: x, cy: y + h },
    w: { cx: x, cy: y + h / 2 },
  };
}

export function DiagramEditor({
  initialJson,
  onCommit,
  onClose,
}: {
  initialJson: string;
  onCommit: (json: string) => void;
  onClose: () => void;
}) {
  const initialObjects = useMemo(() => loadDiagram(initialJson).objects, [initialJson]);
  const [objects, setObjects] = useState<DObj[]>(initialObjects);
  const objectsRef = useRef(objects);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const selRef = useRef(selIds);
  selRef.current = selIds;
  const [tool, setTool] = useState<Tool>('select');
  const [cam, setCam] = useState<Cam>({ tx: 0, ty: 0, scale: 1 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<DObj | null>(null);
  const [hoverShapeId, setHoverShapeId] = useState<string | null>(null);
  // Hover feedback for the select tool (move cursor over objects).
  const [pickHover, setPickHover] = useState(false);
  // Snap anchor currently highlighted while drawing a connector.
  const [hoverSnap, setHoverSnap] = useState<{ id: string; side: Side } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<BBox | null>(null);
  const [editingText, setEditingText] = useState<{ id: string; value: string; isNew: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [iconPanelOpen, setIconPanelOpen] = useState(false);
  const [grid, setGrid] = useState({ show: true, snap: false });
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const [histTick, setHistTick] = useState(0);
  const [style, setStyle] = useState<ObjStyleDefaults>({
    stroke: '#b9b9b9',
    fill: null,
    strokeWidth: 2,
    dash: 'solid',
    textColor: defaultTextColor(),
    fontSize: 16,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fillCustomRef = useRef<HTMLInputElement>(null);
  const spaceDown = useRef(false);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const patternId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const fitDone = useRef(false);
  const liveCommitTimer = useRef<number | null>(null);
  // Delayed blur-commit: lets the focus-recovery loop cancel a commit caused
  // by a transient focus theft right after the textarea opens.
  const blurCommitTimer = useRef<number | null>(null);
  const commitTextEditRef = useRef<() => void>(() => {});

  type Drag =
    | { mode: 'pan'; sx: number; sy: number; cam0: Cam }
    | { mode: 'marquee'; w0: { x: number; y: number }; additive: boolean }
    | { mode: 'move'; w0: { x: number; y: number }; snap: Map<string, Partial<DObj>>; pre: DObj[] }
    | { mode: 'resize'; id: string; handle: HandleId; orig: DObj }
    | { mode: 'rotate'; id: string; c: { x: number; y: number }; a0: number; r0: number }
    | { mode: 'endpoint'; id: string; which: ConnectorEnd; pre: DObj[] }
    | { mode: 'waypoint'; id: string; index: number; pre: DObj[] }
    | { mode: 'draw'; start: { x: number; y: number } }
    | { mode: 'pen'; ox: number; oy: number; pts: number[] }
    | { mode: 'pinch'; d0: number; c0: { x: number; y: number }; cam0: Cam };

  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // How many custom dropdown menus are currently open (Escape coordination).
  const ddOpenRef = useRef(0);
  const registerDd = useCallback((delta: number) => {
    ddOpenRef.current = Math.max(0, ddOpenRef.current + delta);
  }, []);

  // ---- persistence helpers -------------------------------------------------

  const commit = useCallback((next: DObj[]) => {
    undoStack.current.push(serializeDiagram(objectsRef.current));
    if (undoStack.current.length > 120) undoStack.current.shift();
    redoStack.current.length = 0;
    objectsRef.current = next;
    setObjects(next);
    setHistTick((t) => t + 1);
    onCommit(serializeDiagram(next));
  }, [onCommit]);

  // Live updates during a drag: no history entries, debounced persistence.
  const liveReplace = useCallback((next: DObj[]) => {
    objectsRef.current = next;
    setObjects(next);
    if (liveCommitTimer.current) window.clearTimeout(liveCommitTimer.current);
    liveCommitTimer.current = window.setTimeout(() => onCommit(serializeDiagram(next)), 250);
  }, [onCommit]);

  const finishLiveDrag = useCallback((preObjects: DObj[]) => {
    if (liveCommitTimer.current) {
      window.clearTimeout(liveCommitTimer.current);
      liveCommitTimer.current = null;
    }
    undoStack.current.push(serializeDiagram(preObjects));
    if (undoStack.current.length > 120) undoStack.current.shift();
    redoStack.current.length = 0;
    setHistTick((t) => t + 1);
    onCommit(serializeDiagram(objectsRef.current));
  }, [onCommit]);

  const applySnapshot = useCallback((snapshot: string, onto: string[]) => {
    onto.push(serializeDiagram(objectsRef.current));
    redoStack.current.length = 0;
    const next = loadDiagram(snapshot).objects;
    objectsRef.current = next;
    setObjects(next);
    setSelIds(new Set());
    setHistTick((t) => t + 1);
    onCommit(serializeDiagram(next));
  }, [onCommit]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    applySnapshot(prev, redoStack.current);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    applySnapshot(next, undoStack.current);
  }, [applySnapshot]);

  // ---- coordinates ----------------------------------------------------------

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return screenToWorld(clientX - rect.left, clientY - rect.top, cam);
  }, [cam]);

  const toScreen = useCallback((wx: number, wy: number) => ({
    x: wx * cam.scale + cam.tx,
    y: wy * cam.scale + cam.ty,
  }), [cam]);

  const snapVal = useCallback((v: number) => (grid.snap ? Math.round(v / GRID_SIZE) * GRID_SIZE : v), [grid.snap]);
  const snapRef = useRef(snapVal);
  snapRef.current = snapVal;

  // ---- camera ----------------------------------------------------------------

  const fitToContent = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const vw = el.clientWidth || 1200;
    const vh = el.clientHeight || 800;
    const bbox = objectsBBox(objectsRef.current);
    if (!bbox || (!bbox.w && !bbox.h)) {
      setCam({ tx: vw / 2, ty: vh / 2, scale: 1 });
      return;
    }
    const pad = 80;
    const scale = Math.max(0.05, Math.min(2, Math.min(
      (vw - pad * 2) / Math.max(bbox.w, 1),
      (vh - pad * 2) / Math.max(bbox.h, 1),
    )));
    setCam({
      tx: vw / 2 - (bbox.x + bbox.w / 2) * scale,
      ty: vh / 2 - (bbox.y + bbox.h / 2) * scale,
      scale,
    });
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setCam((c) => {
      const scale = Math.max(0.05, Math.min(8, c.scale * factor));
      const real = scale / c.scale;
      return { scale, tx: cx - (cx - c.tx) * real, ty: cy - (cy - c.ty) * real };
    });
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Auto-center / auto-fit whenever the editor opens (requirements #23/#25).
  useEffect(() => {
    if (fitDone.current || !size) return;
    fitDone.current = true;
    fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(cx, cy, Math.exp(-e.deltaY * 0.0015));
      } else {
        setCam((c) => ({ ...c, tx: c.tx - e.deltaX, ty: c.ty - e.deltaY }));
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => () => {
    if (liveCommitTimer.current) window.clearTimeout(liveCommitTimer.current);
  }, []);

  // Pull focus away from the note's contenteditable when the overlay opens —
  // otherwise keystrokes (Delete!) keep reaching ProseMirror underneath and
  // can delete the whole diagram node out of the note.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    rootRef.current?.focus();
    // While open, if the hidden note editor ever tries to grab focus back
    // (click into it, programmatic focus, IME), send focus straight home.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || rootRef.current?.contains(t)) return;
      if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
        t.blur();
        rootRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);

  // ---- object operations ------------------------------------------------------

  const byId = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects]);
  const selected = useMemo(() => objects.filter((o) => selIds.has(o.id)), [objects, selIds]);

  const patchSelection = useCallback((fn: (o: DObj) => DObj) => {
    const ids = selRef.current;
    if (!ids.size) return;
    commit(objectsRef.current.map((o) => (ids.has(o.id) ? fn(o) : o)));
  }, [commit]);

  const deleteSelection = useCallback(() => {
    if (!selRef.current.size) return;
    commit(objectsRef.current.filter((o) => !selRef.current.has(o.id)));
    setSelIds(new Set());
  }, [commit]);

  const duplicateSelection = useCallback(() => {
    if (!selRef.current.size) return;
    const clones = objectsRef.current
      .filter((o) => selRef.current.has(o.id))
      .map((o) => ({ ...clone(o), id: newObjId(), x: o.x + 24, y: o.y + 24 }));
    commit([...objectsRef.current, ...clones]);
    setSelIds(new Set(clones.map((c) => c.id)));
  }, [commit]);

  const copySelection = useCallback(() => {
    if (!selRef.current.size) return;
    clipboardObjects = objectsRef.current.filter((o) => selRef.current.has(o.id)).map(clone);
  }, []);

  const pasteClipboard = useCallback(() => {
    if (!clipboardObjects?.length) return;
    const clones = clipboardObjects.map((o) => ({ ...clone(o), id: newObjId(), x: o.x + 24, y: o.y + 24 }));
    commit([...objectsRef.current, ...clones]);
    setSelIds(new Set(clones.map((c) => c.id)));
  }, [commit]);

  const cutSelection = useCallback(() => {
    copySelection();
    deleteSelection();
  }, [copySelection, deleteSelection]);

  const reorder = useCallback((dir: 'front' | 'back' | 'forward' | 'backward') => {
    if (!selRef.current.size) return;
    const sel = new Set(selRef.current);
    const list = [...objectsRef.current];
    if (dir === 'front') commit([...list.filter((o) => !sel.has(o.id)), ...list.filter((o) => sel.has(o.id))]);
    else if (dir === 'back') commit([...list.filter((o) => sel.has(o.id)), ...list.filter((o) => !sel.has(o.id))]);
    else {
      const next = [...list];
      if (dir === 'forward') {
        for (let i = next.length - 2; i >= 0; i--) {
          if (sel.has(next[i].id) && !sel.has(next[i + 1].id)) {
            [next[i], next[i + 1]] = [next[i + 1], next[i]];
          }
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (sel.has(next[i].id) && !sel.has(next[i - 1].id)) {
            [next[i], next[i - 1]] = [next[i - 1], next[i]];
          }
        }
      }
      commit(next);
    }
  }, [commit]);

  const alignSelection = useCallback((mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => {
    if (selRef.current.size < 2) return;
    const sel = objectsRef.current.filter((o) => selRef.current.has(o.id));
    const u = objectsBBox(sel);
    if (!u) return;
    const patches = new Map<string, Partial<DObj>>();
    for (const o of sel) {
      const b = objBBox(o);
      let dx = 0;
      let dy = 0;
      if (mode === 'left') dx = u.x - b.x;
      if (mode === 'right') dx = u.x + u.w - (b.x + b.w);
      if (mode === 'hcenter') dx = u.x + u.w / 2 - (b.x + b.w / 2);
      if (mode === 'top') dy = u.y - b.y;
      if (mode === 'bottom') dy = u.y + u.h - (b.y + b.h);
      if (mode === 'vcenter') dy = u.y + u.h / 2 - (b.y + b.h / 2);
      patches.set(o.id, shiftPatch(o, dx, dy));
    }
    commit(objectsRef.current.map((o) => (patches.has(o.id) ? { ...o, ...patches.get(o.id)! } : o)));
  }, [commit]);

  const distribute = useCallback((axis: 'h' | 'v') => {
    if (selRef.current.size < 3) return;
    const sel = objectsRef.current.filter((o) => selRef.current.has(o.id));
    const key = axis === 'h' ? 'x' : 'y' as const;
    const dim = axis === 'h' ? 'w' : 'h' as const;
    const boxes = sel.map((o) => ({ o, b: objBBox(o) })).sort((a, b) => a.b[key] - b.b[key]);
    const firstB = boxes[0].b;
    const lastB = boxes[boxes.length - 1].b;
    const span = lastB[key] + lastB[dim] - firstB[key];
    const totalDim = boxes.reduce((acc, x) => acc + x.b[dim], 0);
    const gap = (span - totalDim) / (boxes.length - 1);
    const patches = new Map<string, Partial<DObj>>();
    let cursor = firstB[key];
    for (const { o, b } of boxes) {
      const delta = cursor - b[key];
      patches.set(o.id, axis === 'h' ? { x: o.x + delta } : { y: o.y + delta });
      cursor += b[dim] + gap;
    }
    commit(objectsRef.current.map((o) => (patches.has(o.id) ? { ...o, ...patches.get(o.id)! } : o)));
  }, [commit]);

  // ---- style application ------------------------------------------------------

  const setStrokeColor = (color: string) => {
    setStyle((s) => ({ ...s, stroke: color }));
    if (selRef.current.size) patchSelection((o) => ({ ...o, stroke: color }));
  };
  const setFillColor = (fill: string | null) => {
    setStyle((s) => ({ ...s, fill }));
    if (selRef.current.size) patchSelection((o) => (o.type === 'text' ? o : { ...o, fill }));
  };
  const setWidth = (width: number) => {
    setStyle((s) => ({ ...s, strokeWidth: width }));
    if (selRef.current.size) patchSelection((o) => ({ ...o, strokeWidth: width }));
  };
  const setDash = (dash: NonNullable<DObj['dash']>) => {
    setStyle((s) => ({ ...s, dash }));
    if (selRef.current.size) patchSelection((o) => ({ ...o, dash }));
  };
  const setOpacitySel = (opacity: number) => {
    if (selRef.current.size) patchSelection((o) => ({ ...o, opacity }));
  };
  const setTextProp = (patch: Partial<DObj>) => {
    if (selRef.current.size) patchSelection((o) => ({ ...o, ...patch }));
  };

  const selectionCommon = useMemo(() => {
    if (!selected.length) return null;
    const first = selected[0];
    const uniform = (get: (o: DObj) => unknown) => {
      const v = get(first);
      return selected.every((o) => get(o) === v) ? v : undefined;
    };
    return {
      stroke: uniform((o) => o.stroke) as string | undefined,
      fill: uniform((o) => (o.type === 'text' ? undefined : o.fill)) as string | null | undefined,
      strokeWidth: uniform((o) => o.strokeWidth) as number | undefined,
      dash: uniform((o) => o.dash) as DObj['dash'] | undefined,
      opacity: uniform((o) => o.opacity) as number | undefined,
      fontSize: uniform((o) => o.fontSize) as number | undefined,
      bold: uniform((o) => o.bold) as boolean | undefined,
      italic: uniform((o) => o.italic) as boolean | undefined,
      align: uniform((o) => o.align) as DObj['align'] | undefined,
      route: uniform((o) => o.route) as DObj['route'] | undefined,
      hasTextable: selected.some(isShapeLike),
      hasConnector: selected.some((o) => isConnector(o.type)),
    };
  }, [selected]);

  // Current fill for the dropdown: selection value when present, else the
  // default used for newly drawn shapes.
  const fillValue: string = selectionCommon?.fill !== undefined
    ? (selectionCommon.fill ?? 'none')
    : (style.fill ?? 'none');
  const fillLabel = fillValue === 'none'
    ? 'None'
    : FILL_SWATCHES.find((s) => s.value.toLowerCase() === fillValue.toLowerCase())?.label ?? 'Custom';

  // ---- insertion ---------------------------------------------------------------

  const startTextEditing = useCallback((o: DObj, isNew = false) => {
    // Focus happens via the textarea's ref callback on mount — no timing race.
    setEditingText({ id: o.id, value: o.text || '', isNew });
    // When a NEW box is placed with the text tool, the very click that created
    // it still delivers its compatibility `mousedown` AFTER this textarea has
    // mounted (pointer capture retargets that mousedown to the canvas, not to
    // the textarea under the cursor). Its default action steals focus and
    // blur-closes the editor instantly — so block focus changes from any
    // mousedown during a short arming window. Click handling is unaffected;
    // only the focus side effect of the press is suppressed.
    const guard = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.id === 'dg-text-edit') return;
      e.preventDefault();
    };
    document.addEventListener('mousedown', guard, true);
    window.setTimeout(() => document.removeEventListener('mousedown', guard, true), 400);
  }, []);

  const addShapeAt = useCallback((kind: ShapeKind | 'text', cx: number, cy: number) => {
    const w = kind === 'text' ? 200 : 160;
    const h = kind === 'text' ? 40 : 90;
    const obj = applyDefaults(
      {
        type: kind === 'text' ? 'text' : kind,
        x: cx - w / 2,
        y: cy - h / 2,
        w,
        h,
        // Text boxes derive font size from height by default (→ tiny 12px);
        // pin the user's chosen size so fresh labels are instantly readable.
        ...(kind === 'text' ? { fontSize: style.fontSize } : {}),
      },
      style,
    );
    commit([...objectsRef.current, obj]);
    setSelIds(new Set([obj.id]));
    if (kind === 'text') startTextEditing(obj, true);
    // Tool stays active (sticky) until the user picks another one.
  }, [commit, style, startTextEditing]);

  const insertImageFile = useCallback(async (file: File) => {
    if (!IMAGE_MIME_EXT[file.type]) return;
    try {
      const { name } = await api.uploadAttachment(file, attachmentExtFromMime(file.type));
      const dims = await imageSize(URL.createObjectURL(file));
      const maxSide = 360;
      const k = Math.min(maxSide / Math.max(dims.w, dims.h), 1.6);
      const el = rootRef.current;
      const wpt = screenToWorld(el ? el.clientWidth / 2 : 400, el ? el.clientHeight / 2 : 300, camRef.current);
      const w = Math.max(Math.round(dims.w * k), 24);
      const h = Math.max(Math.round(dims.h * k), 24);
      const obj = applyDefaults({
        type: 'image',
        src: `attachments/${name}`,
        x: snapVal(wpt.x - w / 2),
        y: snapVal(wpt.y - h / 2),
        w,
        h,
      }, style);
      commit([...objectsRef.current, obj]);
      setSelIds(new Set([obj.id]));
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  }, [commit, snapVal, style]);

  const insertIcon = useCallback((icon: SimpleIcon) => {
    const el = rootRef.current;
    const wpt = screenToWorld(
      el ? el.clientWidth / 2 : 400,
      (el ? el.clientHeight / 2 : 300) - 60,
      camRef.current,
    );
    const side = 72;
    const obj = applyDefaults({
      type: 'icon',
      slug: icon.slug,
      iconTitle: icon.title,
      iconPath: icon.path,
      brandColor: `#${icon.hex}`,
      x: snapVal(wpt.x - side / 2),
      y: snapVal(wpt.y - side / 2),
      w: side,
      h: side,
    }, style);
    commit([...objectsRef.current, obj]);
    setSelIds(new Set([obj.id]));
    setIconPanelOpen(false);
  }, [commit, snapVal, style]);

  // ---- text editing -----------------------------------------------------------

  const commitTextEditing = useCallback(() => {
    const ed = editingText;
    if (!ed) return;
    if (blurCommitTimer.current) {
      window.clearTimeout(blurCommitTimer.current);
      blurCommitTimer.current = null;
    }
    setEditingText(null);
    const target = objectsRef.current.find((o) => o.id === ed.id);
    if (!target) return;
    const value = ed.value.replace(/\s+$/, '');
    if (!value.trim()) {
      // A freshly placed TEXT box left empty is just a mis-click — remove it
      // completely so no invisible leftover object confuses the user later
      // (focus is now reliable, so this cannot fire by accident). Existing
      // SHAPES keep their geometry when their label is cleared.
      if (target.type === 'text') {
        commit(objectsRef.current.filter((o) => o.id !== ed.id));
        setSelIds(new Set([...selRef.current].filter((id) => id !== ed.id)));
      } else {
        commit(objectsRef.current.map((o) => (o.id === ed.id ? { ...o, text: '' } : o)));
      }
      // Done writing a new label → back to the select tool, so wandering
      // clicks never spawn surprise boxes (how mainstream tools behave).
      if (ed.isNew) setTool('select');
      return;
    }
    commit(objectsRef.current.map((o) => {
      if (o.id !== ed.id) return o;
      // Text untouched → keep the pasted rich runs. Text edited → the runs no
      // longer match the plain string, so formatting is flattened honestly.
      if (value === (target.text || '')) return o;
      return { ...o, text: value, rich: undefined };
    }));
    if (ed.isNew) setTool('select');
  }, [editingText, commit]);
  commitTextEditRef.current = commitTextEditing;

  const cancelBlurCommit = useCallback(() => {
    if (blurCommitTimer.current) {
      window.clearTimeout(blurCommitTimer.current);
      blurCommitTimer.current = null;
    }
  }, []);

  // A blur right after the editor opens is often bogus (pointer-capture
  // compat events, focus theft). Commit on a short delay instead — if focus
  // returns to the textarea within that window, the recovery loop below
  // cancels the pending commit and typing continues uninterrupted.
  const scheduleBlurCommit = useCallback(() => {
    cancelBlurCommit();
    blurCommitTimer.current = window.setTimeout(() => {
      blurCommitTimer.current = null;
      const el = document.getElementById('dg-text-edit');
      if (el && document.activeElement === el) return;
      commitTextEditRef.current();
    }, 180);
  }, [cancelBlurCommit]);

  // While the text editor is open, keep re-asserting focus for a short
  // window — any stray blur (pointer-capture release, compat mouse events,
  // focus theft) is corrected until the user's first real interaction.
  useEffect(() => {
    if (!editingText) return;
    let tries = 0;
    const focusEl = () => {
      const el = document.getElementById('dg-text-edit') as HTMLTextAreaElement | null;
      if (!el) return false;
      if (document.activeElement === el) {
        cancelBlurCommit();
        return true;
      }
      el.focus({ preventScroll: true });
      const end = el.value.length;
      el.setSelectionRange(end, end);
      if (document.activeElement === el) {
        cancelBlurCommit();
        return true;
      }
      return false;
    };
    focusEl();
    const iv = window.setInterval(() => {
      tries += 1;
      if (focusEl() || tries > 12) window.clearInterval(iv);
    }, 60);
    return () => {
      window.clearInterval(iv);
      cancelBlurCommit();
    };
  }, [editingText, cancelBlurCommit]);

  // Final exit: commit any open text edit, drop leftover empty text boxes,
  // persist, then close.
  const finishAndClose = useCallback(() => {
    if (editingText) commitTextEditing();
    const cleaned = objectsRef.current.filter(
      (o) => !(o.type === 'text' && !(o.text || '').trim()),
    );
    if (cleaned.length !== objectsRef.current.length) {
      objectsRef.current = cleaned;
      setObjects(cleaned);
      onCommit(serializeDiagram(cleaned));
    }
    onClose();
  }, [editingText, commitTextEditing, onCommit, onClose]);

  // ---- pointer interaction -------------------------------------------------------

  // Which endpoint of a selected connector is under the world point (if any).
  const hitConnectorEnd = (o: DObj, w: { x: number; y: number }): ConnectorEnd | null => {
    const tol = Math.max(10 / cam.scale, 6);
    const s = connectorEndPoint(o, 'start', byId);
    const e = connectorEndPoint(o, 'end', byId);
    const ds = Math.hypot(w.x - s.x, w.y - s.y);
    const de = Math.hypot(w.x - e.x, w.y - e.y);
    if (ds <= tol || de <= tol) return ds <= de ? 'start' : 'end';
    return null;
  };

  // Segment index whose midpoint is under the world point — dropping there
  // plants a waypoint (insertion index == segment index in the path). Tight
  // tolerance so plain body-drags still MOVE the whole line instead.
  const hitWaypointIndex = (o: DObj, w: { x: number; y: number }): number => {
    const pts = connectorPolyline(o, byId);
    const tol = Math.max(8 / cam.scale, 6);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      // Skip stub segments created by arrowhead trimming — too tiny to aim.
      if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) * cam.scale < 24) continue;
      const dd = Math.hypot(w.x - mx, w.y - my);
      if (dd <= tol && dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (editingText) commitTextEditing();
    setMenu(null);
    const svg = svgRef.current!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      drag.current = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), c0: midpoint(a, b), cam0: cam };
      svg.setPointerCapture(e.pointerId);
      return;
    }

    const w = toWorld(e.clientX, e.clientY);
    svg.setPointerCapture(e.pointerId);

    if (e.button === 1 || tool === 'hand' || spaceDown.current) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cam0: cam };
      return;
    }

    if (tool === 'select') {
      if (selIds.size === 1) {
        const o = objects.find((x) => selIds.has(x.id));
        if (o) {
          // Connectors expose their two endpoints as grab handles — dragging
          // one resizes the line and re-connects it (drop on a shape = bind,
          // drop on empty space = disconnect).
          if (isConnector(o.type)) {
            const which = hitConnectorEnd(o, w);
            if (which) {
              drag.current = { mode: 'endpoint', id: o.id, which, pre: clone(objectsRef.current) };
              return;
            }
            const wi = hitWaypointIndex(o, w);
            if (wi >= 0) {
              drag.current = { mode: 'waypoint', id: o.id, index: wi, pre: clone(objectsRef.current) };
              return;
            }
          } else {
            const h = hitHandle(o, w, cam.scale);
            if (h === 'rot') {
              const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
              drag.current = { mode: 'rotate', id: o.id, c, a0: Math.atan2(w.y - c.y, w.x - c.x), r0: o.rotation || 0 };
              return;
            }
            if (h) {
              drag.current = { mode: 'resize', id: o.id, handle: h, orig: clone(o) };
              return;
            }
          }
        }
      }
      const picked = pickObject(objects, w.x, w.y, byId);
      if (picked) {
        let working = selIds;
        if (e.shiftKey) {
          working = new Set(selIds);
          if (working.has(picked.id)) working.delete(picked.id);
          else working.add(picked.id);
          setSelIds(working);
          return;
        }
        if (!working.has(picked.id)) {
          working = new Set([picked.id]);
          setSelIds(working);
        }
        const snapshot = new Map<string, Partial<DObj>>();
        for (const o of objectsRef.current) {
          if (working.has(o.id)) snapshot.set(o.id, { x: o.x, y: o.y, x2: o.x2, y2: o.y2 });
        }
        drag.current = { mode: 'move', w0: w, snap: snapshot, pre: clone(objectsRef.current) };
        return;
      }
      if (!e.shiftKey) setSelIds(new Set());
      drag.current = { mode: 'marquee', w0: w, additive: e.shiftKey };
      return;
    }

    if (tool === 'text') {
      addShapeAt('text', snapVal(w.x), snapVal(w.y));
      return;
    }

    if (tool === 'pen') {
      drag.current = { mode: 'pen', ox: w.x, oy: w.y, pts: [0, 0] };
      setDraft(applyDefaults({ type: 'pen', x: w.x, y: w.y, points: [0, 0] }, style));
      return;
    }

    if (isConnectorTool(tool)) {
      drag.current = { mode: 'draw', start: { x: snapVal(w.x), y: snapVal(w.y) } };
      setDraft(applyDefaults({ type: tool, x: snapVal(w.x), y: snapVal(w.y), x2: w.x, y2: w.y }, style));
      return;
    }

    // Shape tools.
    drag.current = { mode: 'draw', start: { x: snapVal(w.x), y: snapVal(w.y) } };
    setDraft(applyDefaults({ type: tool, x: w.x, y: w.y, w: 1, h: 1 }, style));
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) {
      const w = toWorld(e.clientX, e.clientY);
      if (isConnectorTool(tool)) {
        const under = findShapeUnder(objects, w.x, w.y, new Set());
        setHoverShapeId(under?.id ?? null);
        setHoverSnap(under
          ? { id: under.id, side: nearestSide({ x: under.x, y: under.y, w: under.w, h: under.h }, w.x, w.y) }
          : null);
      } else if (tool === 'select') {
        // Hover feedback: move cursor over any selectable object.
        const over = !!pickObject(objects, w.x, w.y, byId);
        setPickHover((prev) => (prev === over ? prev : over));
      }
      return;
    }
    const w = toWorld(e.clientX, e.clientY);

    switch (d.mode) {
      case 'pan':
        setCam({ ...d.cam0, tx: d.cam0.tx + (e.clientX - d.sx), ty: d.cam0.ty + (e.clientY - d.sy) });
        return;
      case 'pinch': {
        const pts = [...pointers.current.values()];
        if (pts.length < 2) return;
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const c = midpoint(pts[0], pts[1]);
        const rect = svgRef.current!.getBoundingClientRect();
        const scale = Math.max(0.05, Math.min(8, d.cam0.scale * (dist / Math.max(d.d0, 1))));
        const real = scale / d.cam0.scale;
        const px = c.x - rect.left;
        const py = c.y - rect.top;
        setCam({
          scale,
          tx: px - (px - d.cam0.tx) * real + (c.x - d.c0.x),
          ty: py - (py - d.cam0.ty) * real + (c.y - d.c0.y),
        });
        return;
      }
      case 'marquee': {
        setMarqueeRect({
          x: Math.min(d.w0.x, w.x),
          y: Math.min(d.w0.y, w.y),
          w: Math.abs(w.x - d.w0.x),
          h: Math.abs(w.y - d.w0.y),
        });
        return;
      }
      case 'move': {
        let dx = w.x - d.w0.x;
        let dy = w.y - d.w0.y;
        if (gridRef.current.snap) {
          dx = Math.round(dx / GRID_SIZE) * GRID_SIZE;
          dy = Math.round(dy / GRID_SIZE) * GRID_SIZE;
        }
        liveReplace(objectsRef.current.map((o) => {
          const s = d.snap.get(o.id);
          if (!s) return o;
          if (isConnector(o.type)) {
            const patch: Partial<DObj> = {};
            if (!o.fromId) { patch.x = (s.x ?? 0) + dx; patch.y = (s.y ?? 0) + dy; }
            if (!o.toId) { patch.x2 = (s.x2 ?? 0) + dx; patch.y2 = (s.y2 ?? 0) + dy; }
            return { ...o, ...patch };
          }
          return { ...o, x: (s.x ?? 0) + dx, y: (s.y ?? 0) + dy };
        }));
        return;
      }
      case 'resize': {
        const { orig, handle } = d;
        const rad = -(orig.rotation || 0) * Math.PI / 180;
        const dcx = w.x - (orig.x + orig.w / 2);
        const dcy = w.y - (orig.y + orig.h / 2);
        const lx = orig.w / 2 + dcx * Math.cos(rad) - dcy * Math.sin(rad);
        const ly = orig.h / 2 + dcx * Math.sin(rad) + dcy * Math.cos(rad);
        const minS = 10;
        let nx = orig.x;
        let ny = orig.y;
        let nw = orig.w;
        let nh = orig.h;
        if (handle.includes('e')) nw = Math.max(minS, lx);
        if (handle.includes('s')) nh = Math.max(minS, ly);
        if (handle.includes('w')) { nw = Math.max(minS, orig.w - lx); nx = orig.x + (orig.w - nw); }
        if (handle.includes('n')) { nh = Math.max(minS, orig.h - ly); ny = orig.y + (orig.h - nh); }
        if ((orig.type === 'image' || orig.type === 'icon')
          && ['nw', 'ne', 'sw', 'se'].includes(handle)) {
          nh = nw * (orig.h / Math.max(orig.w, 1));
          if (handle.includes('n')) ny = orig.y + (orig.h - nh);
        }
        const idx = objectsRef.current.findIndex((x) => x.id === orig.id);
        if (idx >= 0) {
          const next = [...objectsRef.current];
          next[idx] = { ...next[idx], x: nx, y: ny, w: nw, h: nh };
          liveReplace(next);
        }
        return;
      }
      case 'rotate': {
        const a = Math.atan2(w.y - d.c.y, w.x - d.c.x);
        let deg = d.r0 + ((a - d.a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        const rounded = Math.round(deg * 10) / 10;
        const idx = objectsRef.current.findIndex((x) => x.id === d.id);
        if (idx >= 0) {
          const next = [...objectsRef.current];
          next[idx] = { ...next[idx], rotation: rounded };
          liveReplace(next);
        }
        return;
      }
      case 'endpoint': {
        const conn = objectsRef.current.find((o) => o.id === d.id);
        if (!conn || !isConnector(conn.type)) return;
        const x = snapRef.current(w.x);
        const y = snapRef.current(w.y);
        // Clear the dragged side's binding live so the endpoint follows the
        // cursor instead of staying glued to its old shape.
        const next = objectsRef.current.map((o) => (o.id === d.id
          ? (d.which === 'start'
            ? { ...o, x, y, fromId: null, fromSide: undefined }
            : { ...o, x2: x, y2: y, toId: null, toSide: undefined })
          : o));
        liveReplace(next);
        // Snap feedback while hovering shapes (same as when drawing).
        const otherBind = d.which === 'start' ? conn.toId : conn.fromId;
        const under = findShapeUnder(objectsRef.current, w.x, w.y, new Set(otherBind ? [otherBind] : []));
        setHoverShapeId(under?.id ?? null);
        setHoverSnap(under
          ? { id: under.id, side: nearestSide({ x: under.x, y: under.y, w: under.w, h: under.h }, w.x, w.y) }
          : null);
        return;
      }
      case 'waypoint': {
        const conn = objectsRef.current.find((o) => o.id === d.id);
        if (!conn || !isConnector(conn.type)) return;
        // Grow the waypoint list on demand, then move THIS bend point.
        const wps = [...(conn.waypoints ?? [])];
        while (wps.length <= d.index) wps.push({ x: w.x, y: w.y });
        wps[d.index] = { x: snapRef.current(w.x), y: snapRef.current(w.y) };
        liveReplace(objectsRef.current.map((o) => (o.id === d.id ? { ...o, waypoints: wps } : o)));
        return;
      }
      case 'draw': {
        if (!draft) return;
        const end = { x: snapRef.current(w.x), y: snapRef.current(w.y) };
        if (isConnector(draft.type)) {
          // Hold Shift while drawing for instant circuit-board routing.
          const route = e.shiftKey ? 'orthogonal' as const : 'straight' as const;
          setDraft({ ...draft, x: d.start.x, y: d.start.y, x2: end.x, y2: end.y, route });
          const under = findShapeUnder(objects, w.x, w.y, new Set());
          setHoverShapeId(under?.id ?? null);
          setHoverSnap(under
            ? { id: under.id, side: nearestSide({ x: under.x, y: under.y, w: under.w, h: under.h }, w.x, w.y) }
            : null);
        } else {
          setDraft({
            ...draft,
            x: Math.min(d.start.x, end.x),
            y: Math.min(d.start.y, end.y),
            w: Math.max(Math.abs(end.x - d.start.x), 2),
            h: Math.max(Math.abs(end.y - d.start.y), 2),
          });
        }
        return;
      }
      case 'pen': {
        if (!draft) return;
        const lastX = d.pts.length >= 2 ? d.pts[d.pts.length - 2] : 0;
        const lastY = d.pts.length >= 2 ? d.pts[d.pts.length - 1] : 0;
        const nx = w.x - d.ox;
        const ny = w.y - d.oy;
        if (Math.hypot(nx - lastX, ny - lastY) * cam.scale < 2.2) return;
        d.pts.push(nx, ny);
        let minX = 0;
        let minY = 0;
        for (let i = 0; i < d.pts.length; i += 2) {
          minX = Math.min(minX, d.pts[i]);
          minY = Math.min(minY, d.pts[i + 1]);
        }
        const rel = d.pts.map((v, i) => (i % 2 === 0 ? v - minX : v - minY));
        setDraft({ ...draft, x: d.ox + minX, y: d.oy + minY, points: rel });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    drag.current = null;
    const w = toWorld(e.clientX, e.clientY);

    if (!d) {
      setDraft(null);
      setHoverShapeId(null);
      return;
    }

    switch (d.mode) {
      case 'pan':
      case 'pinch':
        return;
      case 'marquee': {
        const rect: BBox = {
          x: Math.min(d.w0.x, w.x),
          y: Math.min(d.w0.y, w.y),
          w: Math.abs(w.x - d.w0.x),
          h: Math.abs(w.y - d.w0.y),
        };
        setMarqueeRect(null);
        if (rect.w < 4 && rect.h < 4) return;
        const base = d.additive ? selRef.current : new Set<string>();
        const hits = new Set(base);
        for (const o of objects) {
          if (boxesIntersect(rect, objBBox(o))) hits.add(o.id);
        }
        setSelIds(hits);
        return;
      }
      case 'move': {
        finishLiveDrag(d.pre);
        return;
      }
      case 'resize': {
        finishLiveDrag(objectsRef.current.map((o) => (o.id === d.orig.id ? d.orig : o)));
        return;
      }
      case 'rotate': {
        finishLiveDrag(objectsRef.current.map((o) => (o.id === d.id ? { ...o, rotation: d.r0 } : o)));
        return;
      }
      case 'endpoint': {
        setHoverShapeId(null);
        setHoverSnap(null);
        const conn = objectsRef.current.find((o) => o.id === d.id);
        if (!conn || !isConnector(conn.type)) return;
        // Drop ON a shape → bind to it (snapped to the nearest side); drop on
        // empty space → leave that end free. One history entry for the whole
        // re-wire.
        const otherBind = d.which === 'start' ? conn.toId : conn.fromId;
        const under = findShapeUnder(objectsRef.current, w.x, w.y, new Set(otherBind ? [otherBind] : []));
        const boxOf = (s: DObj) => ({ x: s.x, y: s.y, w: s.w, h: s.h });
        const bindPatch: Partial<DObj> = d.which === 'start'
          ? { fromId: under?.id ?? null, fromSide: under ? nearestSide(boxOf(under), w.x, w.y) : undefined }
          : { toId: under?.id ?? null, toSide: under ? nearestSide(boxOf(under), w.x, w.y) : undefined };
        objectsRef.current = objectsRef.current.map((o) => (o.id === d.id ? { ...o, ...bindPatch } : o));
        setObjects(objectsRef.current);
        finishLiveDrag(d.pre);
        return;
      }
      case 'waypoint': {
        // Drop a bend back ON the path (without it) to remove the waypoint —
        // drag off the line to bend, drop on the line to unbend (draw.io).
        const conn = objectsRef.current.find((o) => o.id === d.id);
        if (conn && isConnector(conn.type) && conn.waypoints && d.index < conn.waypoints.length) {
          const wp = conn.waypoints[d.index];
          const rest = conn.waypoints.filter((_, i) => i !== d.index);
          const reduced = connectorPolyline({ ...conn, waypoints: rest }, byId);
          const tol = 8 / cam.scale;
          let near = Infinity;
          for (let i = 0; i + 1 < reduced.length; i++) {
            near = Math.min(near, distToSegment(wp.x, wp.y, reduced[i].x, reduced[i].y, reduced[i + 1].x, reduced[i + 1].y));
          }
          if (near <= tol) {
            objectsRef.current = objectsRef.current.map((o) => (
              o.id === d.id ? { ...o, waypoints: rest.length ? rest : undefined } : o
            ));
            setObjects(objectsRef.current);
          }
        }
        finishLiveDrag(d.pre);
        return;
      }
      case 'draw': {
        const dr = draft;
        setDraft(null);
        setHoverShapeId(null);
        setHoverSnap(null);
        if (!dr) return;
        if (isConnector(dr.type)) {
          const len = Math.hypot((dr.x2 ?? 0) - dr.x, (dr.y2 ?? 0) - dr.y);
          if (len < 6) return;
          const endX = dr.x2 ?? w.x;
          const endY = dr.y2 ?? w.y;
          const from = findShapeUnder(objects, dr.x, dr.y, new Set());
          const to = findShapeUnder(objects, endX, endY, new Set([from?.id ?? '']));
          const boxOf = (s: DObj) => ({ x: s.x, y: s.y, w: s.w, h: s.h });
          const fromSide = from ? nearestSide(boxOf(from), dr.x, dr.y) : undefined;
          const toSnapMatch = to && hoverSnap?.id === to.id ? hoverSnap.side : undefined;
          const toSide = to ? (toSnapMatch ?? nearestSide(boxOf(to), endX, endY)) : undefined;
          const obj = applyDefaults({
            ...clone(dr),
            fromId: from?.id ?? null,
            toId: to?.id ?? null,
            fromSide,
            toSide,
          } as Partial<DObj>, style);
          commit([...objectsRef.current, obj]);
          setSelIds(new Set([obj.id]));
        } else if (dr.w < 10 && dr.h < 10) {
          const obj = applyDefaults(
            { type: dr.type, x: d.start.x - 80, y: d.start.y - 45, w: 160, h: 90 },
            style,
          );
          commit([...objectsRef.current, obj]);
          setSelIds(new Set([obj.id]));
        } else {
          commit([...objectsRef.current, dr]);
          setSelIds(new Set([dr.id]));
        }
        // Tool stays active (sticky) — draw several shapes/arrows in a row
        // without re-picking the tool each time.
        return;
      }
      case 'pen': {
        const dr = draft;
        setDraft(null);
        if (!dr?.points?.length) return;
        commit([...objectsRef.current, dr]);
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const w = toWorld(e.clientX, e.clientY);
    const picked = pickObject(objects, w.x, w.y, byId);
    if (picked && picked.type !== 'image' && picked.type !== 'pen') {
      setSelIds(new Set([picked.id]));
      startTextEditing(picked);
      return;
    }
    // Double-clicking empty space with the select tool is the universal
    // "write something here" gesture — place a text box right there.
    if (!picked && tool === 'select') {
      addShapeAt('text', snapVal(w.x), snapVal(w.y));
    }
  };

  // ---- keyboard --------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown.current = true;
      const target = e.target as HTMLElement | null;
      const inOverlay = !!target && !!rootRef.current && rootRef.current.contains(target);
      const tag = target?.tagName;
      // The editor's OWN fields (search box, shape labels) and any open custom
      // dropdown behave natively.
      if (inOverlay && (tag === 'INPUT' || tag === 'TEXTAREA'
        || (target instanceof Element && target.closest('.dg-dd')))) return;

      // CRITICAL: while the whiteboard is open, NO keystroke aimed outside the
      // overlay may reach the hidden note editor — otherwise random typing
      // would edit (or wipe) workspace content behind the user's back. Stop
      // propagation for everything; preventDefault happens per-mapping below.
      if (!inOverlay) e.stopPropagation();

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault(); e.stopPropagation(); redo();
      } else if (mod && e.key.toLowerCase() === 'c') {
        e.stopPropagation(); copySelection();
      } else if (mod && e.key.toLowerCase() === 'x') {
        e.stopPropagation(); cutSelection();
      } else if (mod && e.key.toLowerCase() === 'v') {
        // Internal shape clipboard wins; otherwise let the native `paste`
        // event below carry external (rich text / image) content in.
        if (clipboardObjects?.length) {
          e.preventDefault(); e.stopPropagation(); pasteClipboard();
        }
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault(); e.stopPropagation(); duplicateSelection();
      } else if (mod && e.key.toLowerCase() === 's') {
        // Forward to the app-level save shortcut (Editor.tsx listens on window)
        // so Ctrl+S keeps saving the note while the diagram editor is open.
        e.stopPropagation();
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 's', ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true,
        }));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!editingText) {
          e.preventDefault(); e.stopPropagation(); deleteSelection();
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (iconPanelOpen) setIconPanelOpen(false);
        else if (ddOpenRef.current > 0) return; // the open dropdown closes itself
        else if (menu) setMenu(null);
        else if (editingText) commitTextEditing();
        else if (selRef.current.size) setSelIds(new Set());
        else finishAndClose();
      } else if (e.key.startsWith('Arrow') && selRef.current.size) {
        e.preventDefault(); e.stopPropagation();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        patchSelection((o) => ({ ...o, ...shiftPatch(o, dx, dy) }));
      }
      // NOTE: deliberately NO single-letter tool shortcuts (P/V/R/T…) — they
      // fought with typing and dropdowns. Tools are picked with the mouse.
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false; };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp);
      spaceDown.current = false;
    };
  }, [undo, redo, copySelection, cutSelection, pasteClipboard, duplicateSelection, deleteSelection,
    patchSelection, editingText, commitTextEditing, iconPanelOpen, menu, finishAndClose]);

  // ---- system clipboard paste (rich text / images from anywhere) ------------
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Never hijack pastes aimed at the label/text editor or other fields.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (clipboardObjects?.length) return; // Ctrl+V already handled shapes
      const cd = e.clipboardData;
      if (!cd) return;

      // Image payload → upload as an attachment (same as the toolbar button).
      for (const item of Array.from(cd.items)) {
        if (item.kind === 'file' && IMAGE_MIME_EXT[item.type]) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            e.stopPropagation();
            void insertImageFile(f);
            return;
          }
        }
      }

      const html = cd.getData('text/html');
      const plainRaw = cd.getData('text/plain');
      if (!html && !plainRaw.trim()) return;
      e.preventDefault();
      e.stopPropagation();

      const parsed = html ? htmlToRich(html) : null;
      if (!parsed && !plainRaw.trim()) return;

      const plain = parsed?.plain ?? plainRaw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      const el = rootRef.current;
      const wpt = screenToWorld(el ? el.clientWidth / 2 : 400, el ? el.clientHeight / 2 : 300, camRef.current);
      const w = 340;
      const fontSize = parsed?.fontSize ?? style.fontSize;
      const h = Math.max(estimateTextHeight(plain, w, fontSize), 44);
      const obj = applyDefaults({
        type: 'text',
        x: snapVal(wpt.x - w / 2),
        y: snapVal(wpt.y - h / 2),
        w,
        h,
        fontSize,
        textColor: parsed?.color ?? style.textColor,
        align: plain.includes('\n') ? 'left' : 'center',
        text: plain,
        rich: parsed?.hasFmt ? parsed.rich : undefined,
      }, style);
      commit([...objectsRef.current, obj]);
      setSelIds(new Set([obj.id]));
      setTool('select');
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [insertImageFile, commit, style, snapVal]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    const picked = pickObject(objects, w.x, w.y, byId);
    if (picked && !selIds.has(picked.id)) setSelIds(new Set([picked.id]));
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // ---- render ---------------------------------------------------------------------

  const inv = 1 / cam.scale;
  const singleSel = selected.length === 1 ? selected[0] : null;
  const handles = singleSel && !isConnector(singleSel.type) && singleSel.type !== 'pen'
    ? handlePositions(singleSel)
    : null;
  const rotAnchor = singleSel && handles
    ? rotatePoint(handles.n.cx, handles.n.cy - 22 * inv, singleSel.x + singleSel.w / 2, singleSel.y + singleSel.h / 2, singleSel.rotation || 0)
    : null;

  const editingTarget = editingText ? objects.find((o) => o.id === editingText.id) : null;
  // Position the textarea over the object's real bounding box — for
  // connectors (w=h=0) that's the endpoint span, so edge labels open centered
  // on the line.
  const edBB = editingTarget ? objBBox(editingTarget) : null;
  const edScr = edBB ? toScreen(edBB.x, edBB.y) : null;
  const edW = edBB ? Math.max(edBB.w * cam.scale, 120) : 0;
  const edH = edBB && editingTarget
    ? Math.max(
        edBB.h * cam.scale,
        estimateTextHeight(editingText!.value || ' ', Math.max(edBB.w, 60), editingTarget.fontSize || 16) * cam.scale,
      )
    : 0;

  const outlineFor = (o: DObj): BBox => ({ x: o.x - 3, y: o.y - 3, w: o.w + 6, h: o.h + 6 });

  const toolCls = (t: Tool) => `toolbar-btn${tool === t ? ' active' : ''}`;
  void histTick; // history buttons read stacks directly; tick forces re-render

  return createPortal(
    <div className="dg-overlay" ref={rootRef} tabIndex={-1} onKeyDown={(e) => e.stopPropagation()}>
      {/* ---------- toolbar ---------- */}
      <div className="dg-toolbar" role="toolbar" aria-label="Diagram tools">
        <button type="button" className={toolCls('select')} title="Select" onClick={() => setTool('select')}><MousePointer2 size={15} /></button>
        <DropDown
          title="Shapes"
          label={(
            <>
              <Shapes size={15} />
              <span className="dg-dd-text">{SHAPE_MENU.find((s) => s.kind === tool)?.label ?? 'Shapes'}</span>
            </>
          )}
          value={SHAPE_MENU.some((s) => s.kind === tool) ? (tool as string) : undefined}
          options={SHAPE_MENU.map((s) => ({ value: s.kind, label: s.label }))}
          onChange={(v) => setTool(v as ShapeKind)}
          register={registerDd}
        />
        <button type="button" className={toolCls('arrow')} title="Arrow — ends snap to shapes" onClick={() => setTool('arrow')}><ArrowRight size={15} /></button>
        <button type="button" className={toolCls('line')} title="Line" onClick={() => setTool('line')}><Minus size={15} /></button>
        <button type="button" className={toolCls('pen')} title="Pen" onClick={() => setTool('pen')}><Pencil size={15} /></button>
        <button type="button" className={toolCls('text')} title="Text — click or double-click the canvas to write" onClick={() => setTool('text')}><TypeIcon size={15} /></button>
        <button type="button" className="toolbar-btn" title="Insert image from device" onClick={() => fileRef.current?.click()}><ImageIcon size={15} /></button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) insertImageFile(f);
            e.target.value = '';
          }}
        />
        <button type="button" className={`toolbar-btn${iconPanelOpen ? ' active' : ''}`} title="Icon library (docker, aws, python…)" onClick={() => setIconPanelOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
            <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4z" />
            <path d="M13 13h7v7h-7z" opacity=".55" />
          </svg>
        </button>

        <span className="dg-sep" />
        <button type="button" className="toolbar-btn" title="Undo (Ctrl+Z)" disabled={!undoStack.current.length} onClick={undo}><Undo2 size={15} /></button>
        <button type="button" className="toolbar-btn" title="Redo (Ctrl+Y)" disabled={!redoStack.current.length} onClick={redo}><Redo2 size={15} /></button>
        <span className="dg-sep" />
        <button type="button" className={`toolbar-btn${grid.show ? ' active' : ''}`} title="Toggle grid" onClick={() => setGrid((g) => ({ ...g, show: !g.show }))}><Grid3x3 size={15} /></button>
        <button type="button" className={`toolbar-btn${grid.snap ? ' active' : ''}`} title="Snap to grid" onClick={() => setGrid((g) => ({ ...g, snap: !g.snap }))}><Magnet size={15} /></button>
        <button type="button" className={toolCls('hand')} title="Pan · Space-drag or middle-drag" onClick={() => setTool('hand')}><Hand size={15} /></button>

        <div className="dg-toolbar-spacer" />
        <span className="dg-hint">{hintFor(tool)}</span>
        <button type="button" className="toolbar-btn" title="Fit diagram to screen" onClick={fitToContent}><Maximize2 size={15} /></button>
        <button type="button" className="toolbar-btn" title="Zoom out"
          onClick={() => { const el = rootRef.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 0.85); }}>
          <ZoomOut size={15} />
        </button>
        <span className="dg-zoom-label">{Math.round(cam.scale * 100)}%</span>
        <button type="button" className="toolbar-btn" title="Zoom in"
          onClick={() => { const el = rootRef.current!; zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.18); }}>
          <ZoomIn size={15} />
        </button>
        <button type="button" className="toolbar-btn dg-done" title="Close editor — everything autosaves" onClick={finishAndClose}>
          <X size={14} /> Done
        </button>
      </div>

      {/* ---------- properties ---------- */}
      <div className="dg-props">
        <label className="dg-prop" title="Stroke color">
          <span className="dg-swatch" style={{ background: normalizeHex(selectionCommon?.stroke ?? style.stroke, '#b9b9b9') }} />
          <input type="color" value={normalizeHex(selectionCommon?.stroke ?? style.stroke, '#b9b9b9')}
            onChange={(e) => setStrokeColor(e.target.value)} />
        </label>
        <DropDown
          title="Fill colour"
          label={(
            <>
              <span
                className="dg-swatch dg-swatch-fill"
                style={{ background: fillValue === 'none' ? 'transparent' : fillValue }}
              />
              <span className="dg-dd-text">{fillLabel}</span>
            </>
          )}
          value={fillValue}
          options={[
            { value: 'none', label: 'None (transparent)' },
            ...FILL_SWATCHES,
            { value: '__custom__', label: 'Custom colour…' },
          ]}
          onChange={(v) => {
            if (v === '__custom__') fillCustomRef.current?.click();
            else setFillColor(v === 'none' ? null : v);
          }}
          register={registerDd}
        />
        <input
          ref={fillCustomRef}
          type="color"
          defaultValue="#565656"
          style={{ position: 'absolute', left: -100, top: -100, width: 1, height: 1, opacity: 0 }}
          onChange={(e) => setFillColor(e.target.value)}
        />

        <DropDown title="Stroke width" value={String(selectionCommon?.strokeWidth ?? style.strokeWidth)}
          options={[1, 2, 3, 4, 6, 8].map((wv) => ({ value: String(wv), label: `${wv}px` }))}
          onChange={(v) => setWidth(Number(v))} register={registerDd} />
        <DropDown title="Line style" value={(selectionCommon?.dash ?? style.dash) || 'solid'}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' },
            { value: 'dotted', label: 'Dotted' },
          ]}
          onChange={(v) => setDash(v as NonNullable<DObj['dash']>)} register={registerDd} />
        <DropDown title="Opacity" value={String(selectionCommon?.opacity ?? 100)}
          options={[25, 50, 75, 100].map((v) => ({ value: String(v), label: `${v}%` }))}
          onChange={(v) => setOpacitySel(Number(v))} register={registerDd} />

        {selectionCommon?.hasTextable && (
          <>
            <span className="dg-sep" />
            <label className="dg-prop" title="Text color">
              <span className="dg-swatch dg-text-swatch">A</span>
              <input type="color" defaultValue="#e6e6e6" onChange={(e) => setTextProp({ textColor: e.target.value })} />
            </label>
            <DropDown title="Font size" value={String(selectionCommon.fontSize ?? style.fontSize)}
              options={[11, 13, 16, 20, 26, 34, 48].map((f) => ({ value: String(f), label: String(f) }))}
              onChange={(v) => setTextProp({ fontSize: Number(v) })} register={registerDd} />
            <button type="button" className={`toolbar-btn${selectionCommon.bold ? ' active' : ''}`} title="Bold text"
              onMouseDown={(ev) => ev.preventDefault()} onClick={() => setTextProp({ bold: !selectionCommon.bold })}><Bold size={14} /></button>
            <button type="button" className={`toolbar-btn${selectionCommon.italic ? ' active' : ''}`} title="Italic text"
              onMouseDown={(ev) => ev.preventDefault()} onClick={() => setTextProp({ italic: !selectionCommon.italic })}><Italic size={14} /></button>
            <DropDown title="Text alignment" value={selectionCommon.align ?? 'center'}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(v) => setTextProp({ align: v as DObj['align'] })} register={registerDd} />
          </>
        )}

        {selectionCommon?.hasConnector && (
          <>
            <DropDown title="Line style — routing" value={selectionCommon.route ?? 'straight'}
              options={[
                { value: 'straight', label: 'Straight line' },
                { value: 'orthogonal', label: 'Right-angle (circuit)' },
                { value: 'curved', label: 'Curved' },
              ]}
              onChange={(v) => patchSelection((o) => (isConnector(o.type) ? { ...o, route: v as DObj['route'] } : o))}
              register={registerDd} />
            <DropDown title="Arrowheads" label={<span className="dg-dd-text">Arrowheads…</span>}
              options={[
                { value: 'none,arrow', label: 'End →' },
                { value: 'arrow,arrow', label: 'Both ↔' },
                { value: 'circle,arrow', label: '●→' },
                { value: 'arrow,circle', label: '→●' },
                { value: 'circle,circle', label: '●—●' },
                { value: 'none,circle', label: 'End ●' },
                { value: 'none,none', label: 'None' },
              ]}
              onChange={(v) => {
                const [sa2, ea] = v.split(',') as [DObj['startArrow'], DObj['endArrow']];
                patchSelection((o) => (isConnector(o.type) ? { ...o, startArrow: sa2, endArrow: ea } : o));
              }} register={registerDd} />
          </>
        )}

        {!!selIds.size && (
          <>
            <span className="dg-sep" />
            <button type="button" className="toolbar-btn" title="Reset rotation" onClick={() => patchSelection((o) => ({ ...o, rotation: 0 }))}><RotateCcw size={14} /></button>
            <button type="button" className="toolbar-btn" title="Bring forward" onClick={() => reorder('forward')}><ChevronUp size={14} /></button>
            <button type="button" className="toolbar-btn" title="Bring to front" onClick={() => reorder('front')}><ChevronsUp size={14} /></button>
            <button type="button" className="toolbar-btn" title="Send backward" onClick={() => reorder('backward')}><ChevronDown size={14} /></button>
            <button type="button" className="toolbar-btn" title="Send to back" onClick={() => reorder('back')}><ChevronsDown size={14} /></button>
            <button type="button" className="toolbar-btn" title="Duplicate (Ctrl+D)" onClick={duplicateSelection}><Copy size={14} /></button>
            <button type="button" className="toolbar-btn dg-danger" title="Delete (Del)" onClick={deleteSelection}><Trash2 size={14} /></button>
          </>
        )}
      </div>

      {/* ---------- canvas ---------- */}
      <div className="dg-canvas-wrap">
        <svg
          ref={svgRef}
          className={`dg-canvas${editingText ? ' dg-editing' : ''}`}
          width="100%"
          height="100%"
          style={{
            cursor: drag.current ? 'grabbing'
              : tool === 'hand' ? 'grab'
              : tool === 'select' ? (pickHover ? 'move' : 'default')
              : tool === 'text' ? 'text' : 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { setHoverShapeId(null); setHoverSnap(null); }}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        >
          <defs>
            <pattern id={`grid-${patternId}`} width={GRID_SIZE * 2} height={GRID_SIZE * 2} patternUnits="userSpaceOnUse">
              <circle cx={1} cy={1} r={1} fill="var(--border-strong)" opacity="0.5" />
            </pattern>
          </defs>
          <g transform={`translate(${cam.tx} ${cam.ty}) scale(${cam.scale})`}>
            {grid.show && (
              <rect x={-100000} y={-100000} width={200000} height={200000} fill={`url(#grid-${patternId})`} />
            )}
            {objects.map((o) => (
              <g key={o.id}>
                {(selIds.has(o.id) || hoverShapeId === o.id) && (
                  isConnector(o.type)
                    // Edges highlight along their actual path — like draw.io,
                    // not as a bounding rectangle.
                    ? <path
                        d={connectorPolyline(o, byId).map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke={selIds.has(o.id) ? 'var(--accent-strong)' : 'var(--accent)'}
                        strokeWidth={3}
                        vectorEffect="non-scaling-stroke"
                        opacity={0.9}
                        pointerEvents="none"
                      />
                    : <SelectionOutline box={outlineFor(o)} rotation={o.rotation} cx={o.x + o.w / 2} cy={o.y + o.h / 2} color={selIds.has(o.id) ? 'var(--accent-strong)' : 'var(--accent)'} />
                )}
                <ObjectNode o={o} byId={byId} />
              </g>
            ))}
            {draft && <ObjectNode o={draft} byId={byId} />}
            {draft && isConnector(draft.type) && (
              <>
                <StartDot o={draft} inv={inv} />
                <EndDot o={draft} inv={inv} />
              </>
            )}

            {/* Snap anchor points on the hovered shape while a connector tool
                is active OR while an endpoint is being re-wired — drop on one
                to attach the line there. */}
            {(isConnectorTool(tool) || drag.current?.mode === 'endpoint') && (() => {
              const sid = hoverSnap?.id ?? hoverShapeId;
              const sh = sid ? objects.find((o) => o.id === sid) : null;
              if (!sh || isConnector(sh.type) || sh.type === 'pen') return null;
              const box = { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
              return (
                <g pointerEvents="none">
                  {(['n', 'e', 's', 'w'] as Side[]).map((s) => {
                    const p = sideMidpoint(box, s);
                    const active = hoverSnap?.id === sh.id && hoverSnap.side === s;
                    return (
                      <g key={s}>
                        {active && (
                          <circle
                            cx={p.x} cy={p.y} r={11 * inv}
                            fill="none" stroke="var(--accent-strong)"
                            strokeWidth={1.4 * inv}
                            className="dg-snap-pulse"
                          />
                        )}
                        <circle
                          cx={p.x} cy={p.y}
                          r={(active ? 6.5 : 4.5) * inv}
                          fill={active ? 'var(--accent-strong)' : 'var(--bg-elevated)'}
                          stroke="var(--accent-strong)"
                          strokeWidth={1.4 * inv}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })()}

            {handles && singleSel && (
              <g>
                {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as HandleId[]).map((hid) => {
                  const hp = handles[hid];
                  const scr = rotatePoint(hp.cx, hp.cy, singleSel.x + singleSel.w / 2, singleSel.y + singleSel.h / 2, singleSel.rotation || 0);
                  return (
                    <circle
                      key={hid}
                      cx={scr.x}
                      cy={scr.y}
                      r={(hid.length === 1 ? 4 : 5) * inv}
                      className="dg-handle"
                      fill="var(--bg-elevated)"
                      stroke="var(--accent-strong)"
                      strokeWidth={1.4 * inv}
                      style={{ cursor: `${hid}-resize` }}
                    />
                  );
                })}
                {rotAnchor && (
                  <>
                    <line
                      x1={rotatePoint(handles.n.cx, handles.n.cy, singleSel.x + singleSel.w / 2, singleSel.y + singleSel.h / 2, singleSel.rotation || 0).x}
                      y1={rotatePoint(handles.n.cx, handles.n.cy, singleSel.x + singleSel.w / 2, singleSel.y + singleSel.h / 2, singleSel.rotation || 0).y}
                      x2={rotAnchor.x}
                      y2={rotAnchor.y}
                      stroke="var(--accent-strong)"
                      strokeWidth={inv}
                    />
                    <circle cx={rotAnchor.x} cy={rotAnchor.y} r={5 * inv}
                      fill="var(--bg-elevated)" stroke="var(--accent-strong)" strokeWidth={inv}
                      style={{ cursor: 'grab' }} />
                  </>
                )}
              </g>
            )}

            {marqueeRect && (
              <rect x={marqueeRect.x} y={marqueeRect.y} width={marqueeRect.w} height={marqueeRect.h}
                fill="var(--accent)" opacity="0.08" stroke="var(--accent-strong)" strokeWidth={inv}
                strokeDasharray={`${4 * inv} ${3 * inv}`} />
            )}

            {/* Draggable endpoints of a selected connector: filled = bound to
                a shape, hollow = free. Drag to resize / re-wire. */}
            {singleSel && isConnector(singleSel.type) && (() => {
              const s = connectorEndPoint(singleSel, 'start', byId);
              const en = connectorEndPoint(singleSel, 'end', byId);
              const r = Math.max(5 * inv, 4);
              return (
                <g>
                  <circle cx={s.x} cy={s.y} r={r}
                    fill={singleSel.fromId ? 'var(--accent-strong)' : 'var(--bg-elevated)'}
                    stroke="var(--accent-strong)" strokeWidth={1.6 * inv}
                    style={{ cursor: 'move' }} />
                  <circle cx={en.x} cy={en.y} r={r}
                    fill={singleSel.toId ? 'var(--accent-strong)' : 'var(--bg-elevated)'}
                    stroke="var(--accent-strong)" strokeWidth={1.6 * inv}
                    style={{ cursor: 'move' }} />
                </g>
              );
            })()}

            {/* Waypoint handles: drag a segment's midpoint to plant a bend
                there (draw.io-style). Diamonds, smaller than the endpoints. */}
            {singleSel && isConnector(singleSel.type) && (() => {
              const pts = connectorPolyline(singleSel, byId);
              const s = Math.max(7 * inv, 6);
              const out: ReactNode[] = [];
              for (let i = 0; i + 1 < pts.length; i++) {
                if (Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) * cam.scale < 26) continue;
                const mx = (pts[i].x + pts[i + 1].x) / 2;
                const my = (pts[i].y + pts[i + 1].y) / 2;
                out.push(
                  <rect key={`wp-${i}`} x={mx - s / 2} y={my - s / 2} width={s} height={s}
                    transform={`rotate(45 ${mx} ${my})`}
                    fill="var(--bg-elevated)" stroke="var(--accent-strong)" strokeWidth={1.4 * inv}
                    style={{ cursor: 'move' }} />,
                );
              }
              return <g>{out}</g>;
            })()}
          </g>
        </svg>

        {editingTarget && edScr && editingText && (
          <>
            {/* Backdrop swallows every outside click while typing so the
                canvas can never interfere with the text editor. */}
            <div
              className="dg-edit-backdrop"
              onPointerDown={() => commitTextEditing()}
            />
            <textarea
              key={editingText.id}
              id="dg-text-edit"
              autoFocus
              className="dg-textarea"
              onMouseDown={(e) => e.stopPropagation()}
              spellCheck={false}
              style={{
                left: edScr.x,
                top: edScr.y,
                width: edW,
                minHeight: edH,
                fontSize: (editingTarget.fontSize || 16) * cam.scale,
                textAlign: editingTarget.align || 'center',
                fontWeight: editingTarget.bold ? 700 : 400,
                fontStyle: editingTarget.italic ? 'italic' : 'normal',
                color: editingTarget.textColor || 'var(--text)',
              }}
              value={editingText.value}
              placeholder="Type text… (Esc to finish)"
              onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
              onFocus={cancelBlurCommit}
              onBlur={scheduleBlurCommit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  commitTextEditing();
                }
              }}
            />
          </>
        )}

        {menu && (
          <div className="dg-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
            {buildMenuItems({
              count: selIds.size,
              run: (fn) => { setMenu(null); fn(); },
              cut: cutSelection,
              copy: copySelection,
              paste: pasteClipboard,
              dup: duplicateSelection,
              del: deleteSelection,
              editText: () => {
                const o = selected.find(isShapeLike) || selected.find((s) => s.type === 'text');
                if (o) startTextEditing(o);
              },
              reorder,
              align: alignSelection,
              distribute,
            }).map((mi) => (
              mi.sep
                ? <div key={mi.key} className="dg-menu-sep" />
                : (
                  <button key={mi.key} type="button" className="dg-menu-item" disabled={mi.disabled} onClick={() => mi.run!()}>
                    {mi.label}
                    {mi.shortcut && <span className="dg-menu-kbd">{mi.shortcut}</span>}
                  </button>
                )
            ))}
          </div>
        )}

        <IconPicker open={iconPanelOpen} onClose={() => setIconPanelOpen(false)} onPick={insertIcon} />

        {!objects.length && (
          <div className="dg-empty-hint">
            Empty diagram — drag to draw shapes, press T to write,<br />
            or just double-click anywhere to add text.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---- render helpers ----------------------------------------------------------

function SelectionOutline({ box, rotation, cx, cy, color }: {
  box: BBox; rotation?: number; cx: number; cy: number; color: string;
}) {
  return (
    <rect
      x={box.x}
      y={box.y}
      width={Math.max(box.w, 2)}
      height={Math.max(box.h, 2)}
      rx={6}
      fill="none"
      stroke={color}
      strokeWidth={1.4}
      strokeDasharray="6 4"
      className="dg-selection-outline"
      vectorEffect="non-scaling-stroke"
      transform={rotation ? `rotate(${rotation} ${cx} ${cy})` : undefined}
      pointerEvents="none"
    />
  );
}

function StartDot({ o, inv }: { o: DObj; inv: number }) {
  return <circle cx={o.x} cy={o.y} r={4 * inv} fill="var(--accent-strong)" opacity="0.85" pointerEvents="none" />;
}
function EndDot({ o, inv }: { o: DObj; inv: number }) {
  return <circle cx={o.x2 ?? o.x} cy={o.y2 ?? o.y} r={4 * inv} fill="var(--accent-strong)" opacity="0.85" pointerEvents="none" />;
}

function hitHandle(o: DObj, w: { x: number; y: number }, scale: number): HandleId | 'rot' | null {
  const tol = 10 / scale;
  const hs = handlePositions(o);
  const rotP = rotatePoint(hs.n.cx, hs.n.cy - 22 / scale, o.x + o.w / 2, o.y + o.h / 2, o.rotation || 0);
  if (Math.hypot(w.x - rotP.x, w.y - rotP.y) <= tol + 3 / scale) return 'rot';
  for (const hid of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as HandleId[]) {
    const hp = rotatePoint(hs[hid].cx, hs[hid].cy, o.x + o.w / 2, o.y + o.h / 2, o.rotation || 0);
    if (Math.hypot(w.x - hp.x, w.y - hp.y) <= tol) return hid;
  }
  return null;
}

function isConnectorTool(t: Tool): t is 'arrow' | 'line' {
  return t === 'arrow' || t === 'line';
}

// Custom dropdown: stays open until an option is picked or the user clicks
// elsewhere. Used instead of native <select>, whose popup is unreliable
// inside portals / remote-browser sessions.
function DropDown({ title, label, value, options, onChange, register }: {
  title: string;
  label?: ReactNode;
  value?: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  register?: (delta: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    register?.(1);
    const onDocMouseDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      register?.(-1);
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, register]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="dg-dd" ref={boxRef} title={title}>
      <button
        type="button"
        className={`toolbar-btn dg-dd-trigger${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="dg-dd-label">{label ?? (current?.label ?? '')}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="dg-dd-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dg-dd-option${o.value === value ? ' selected' : ''}`}
              onClick={() => {
                setOpen(false);
                onChange(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface MenuItem {
  key: string;
  label?: string;
  shortcut?: string;
  sep?: boolean;
  disabled?: boolean;
  run?: () => void;
}

function buildMenuItems(a: {
  count: number;
  run: (fn: () => void) => void;
  cut: () => void; copy: () => void; paste: () => void; dup: () => void; del: () => void;
  editText: () => void;
  reorder: (d: 'front' | 'back' | 'forward' | 'backward') => void;
  align: (m: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => void;
  distribute: (ax: 'h' | 'v') => void;
}): MenuItem[] {
  const has = a.count > 0;
  const multi = a.count > 1;
  return [
    { key: 'edit', label: 'Edit text', disabled: !has, run: () => a.run(a.editText) },
    { key: 'sep0', sep: true },
    { key: 'cut', label: 'Cut', shortcut: 'Ctrl+X', disabled: !has, run: () => a.run(a.cut) },
    { key: 'copy', label: 'Copy', shortcut: 'Ctrl+C', disabled: !has, run: () => a.run(a.copy) },
    { key: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !clipboardObjects?.length, run: () => a.run(a.paste) },
    { key: 'dup', label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !has, run: () => a.run(a.dup) },
    { key: 'del', label: 'Delete', shortcut: 'Del', disabled: !has, run: () => a.run(a.del) },
    { key: 'sep1', sep: true },
    { key: 'fwd', label: 'Bring forward', disabled: !has, run: () => a.run(() => a.reorder('forward')) },
    { key: 'front', label: 'Bring to front', disabled: !has, run: () => a.run(() => a.reorder('front')) },
    { key: 'bwd', label: 'Send backward', disabled: !has, run: () => a.run(() => a.reorder('backward')) },
    { key: 'back', label: 'Send to back', disabled: !has, run: () => a.run(() => a.reorder('back')) },
    { key: 'sep2', sep: true },
    { key: 'al', label: 'Align left', disabled: !multi, run: () => a.run(() => a.align('left')) },
    { key: 'ac', label: 'Align centers', disabled: !multi, run: () => a.run(() => a.align('hcenter')) },
    { key: 'ar', label: 'Align right', disabled: !multi, run: () => a.run(() => a.align('right')) },
    { key: 'at', label: 'Align top', disabled: !multi, run: () => a.run(() => a.align('top')) },
    { key: 'am', label: 'Align middles', disabled: !multi, run: () => a.run(() => a.align('vcenter')) },
    { key: 'ab', label: 'Align bottom', disabled: !multi, run: () => a.run(() => a.align('bottom')) },
    { key: 'dh', label: 'Distribute horizontally', disabled: a.count < 3, run: () => a.run(() => a.distribute('h')) },
    { key: 'dv', label: 'Distribute vertically', disabled: a.count < 3, run: () => a.run(() => a.distribute('v')) },
  ];
}
