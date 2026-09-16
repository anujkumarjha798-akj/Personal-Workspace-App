// Diagram object model + (de)serialization. Diagrams are stored as a JSON
// string in the `diagram` attribute of the `diagram` Tiptap node, so they ride
// entirely on the existing page-content persistence path (workspace.json,
// autosave, Ctrl+S, backups, revisions).

export type ShapeKind =
  | 'rect'
  | 'roundrect'
  | 'ellipse'
  | 'diamond'
  | 'triangle'
  | 'star'
  | 'parallelogram'   // flowchart: input/output
  | 'cylinder'        // flowchart: database
  | 'doc'             // flowchart: document
  | 'preprocess'      // flowchart: predefined process
  | 'terminator';     // flowchart: start/end

export type ObjType = ShapeKind | 'arrow' | 'line' | 'pen' | 'text' | 'image' | 'icon';
export type DashStyle = 'solid' | 'dashed' | 'dotted';
export type ArrowHead = 'none' | 'arrow' | 'circle';

// Free bend-point on a connector (draw.io-style waypoints).
export interface DPoint { x: number; y: number }

// Inline formatting run inside a text object — produced by pasting rich text
// from the note editor. Adjacent characters sharing formatting share a seg.
export interface DRichSeg {
  t: string;
  b?: boolean;      // bold
  i?: boolean;      // italic
  c?: string;       // text color (#rrggbb)
  s?: number;       // font size px
}

export interface DObj {
  id: string;
  type: ObjType;
  // Bounding box in world coordinates (for connectors this is the start point).
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number; // degrees around center (shapes/text/image/icon)

  stroke?: string;
  fill?: string | null;    // null = transparent
  strokeWidth?: number;
  dash?: DashStyle;
  opacity?: number;        // 0..100

  text?: string;
  rich?: DRichSeg[];  // optional inline formatting runs (text objects)
  fontSize?: number;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';

  // Connectors (arrow/line): absolute end point.
  x2?: number;
  y2?: number;
  fromId?: string | null;  // bind start to shape id
  toId?: string | null;    // bind end to shape id
  fromSide?: 'n' | 'e' | 's' | 'w';  // snapped anchor side on the source shape
  toSide?: 'n' | 'e' | 's' | 'w';
  startArrow?: ArrowHead;
  endArrow?: ArrowHead;
  route?: 'straight' | 'orthogonal' | 'curved';  // orthogonal = circuit-board right angles
  waypoints?: DPoint[];  // user-placed bend points, in order start → end

  // Pen freehand: flat [dx,dy,…] offsets relative to x/y.
  points?: number[];

  // Images: attachment ref ("attachments/name") or data URI.
  src?: string;
  // Icons: snapshot of the resolved simple-icon so previews never need the library.
  slug?: string;
  iconTitle?: string;
  iconPath?: string;
  brandColor?: string;
}

export interface DiagramData {
  v: 1;
  objects: DObj[];
}

export const DIAGRAM_VERSION = 1 as const;

export const SHAPE_KINDS: ShapeKind[] = [
  'rect', 'roundrect', 'ellipse', 'diamond', 'triangle', 'star',
  'parallelogram', 'cylinder', 'doc', 'preprocess', 'terminator',
];
export const CONNECTOR_TYPES: ObjType[] = ['arrow', 'line'];

export function isShape(t: ObjType): boolean {
  return (SHAPE_KINDS as string[]).includes(t);
}

export function isConnector(t: ObjType): boolean {
  return t === 'arrow' || t === 'line';
}

export function newObjId(): string {
  return `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface ObjStyleDefaults {
  stroke: string;
  fill: string | null;
  strokeWidth: number;
  dash: DashStyle;
  textColor: string;
  fontSize: number;
}

export function applyDefaults(o: Partial<DObj>, d: ObjStyleDefaults): DObj {
  const base: DObj = {
    id: o.id || newObjId(),
    type: o.type!,
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: Math.max(num(o.w, 120), 4),
    h: Math.max(num(o.h, 60), 4),
    rotation: num(o.rotation, 0) || undefined,
    stroke: o.stroke ?? d.stroke,
    fill: o.fill === undefined ? d.fill : o.fill,
    strokeWidth: clampNum(o.strokeWidth ?? d.strokeWidth, 0.5, 16),
    dash: o.dash ?? d.dash,
    opacity: clampNum(o.opacity ?? 100, 5, 100),
    text: typeof o.text === 'string' ? o.text : undefined,
    fontSize: clampNum(o.fontSize ?? Math.min(18, Math.max(12, num(o.h, 60) * 0.22)), 8, 72),
    textColor: o.textColor ?? d.textColor,
    bold: !!o.bold,
    italic: !!o.italic,
    align: o.align ?? 'center',
  };
  // Sanitize pasted rich-text runs — one bad segment must never break a note.
  if (Array.isArray(o.rich)) {
    const clean = (o.rich as unknown[]).slice(0, 400).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const r = raw as Record<string, unknown>;
      const t = typeof r.t === 'string' ? r.t.slice(0, 2000) : '';
      if (!t) return [];
      const seg: DRichSeg = { t };
      if (r.b === true) seg.b = true;
      if (r.i === true) seg.i = true;
      if (typeof r.c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(r.c)) seg.c = r.c;
      if (typeof r.s === 'number' && Number.isFinite(r.s)) seg.s = clampNum(r.s, 8, 72);
      return [seg];
    });
    if (clean.length) base.rich = clean;
  }
  if (isConnector(base.type)) {
    base.x2 = num(o.x2, base.x + 140);
    base.y2 = num(o.y2, base.y);
    base.fromId = o.fromId ?? null;
    base.toId = o.toId ?? null;
    base.fromSide = o.fromSide;
    base.toSide = o.toSide;
    base.startArrow = o.startArrow && o.startArrow !== 'arrow' ? o.startArrow : undefined;
    if (base.type === 'arrow') base.endArrow = o.endArrow === 'circle' ? 'circle' : 'arrow';
    else base.endArrow = o.endArrow === 'arrow' ? 'arrow' : (o.endArrow ?? undefined);
    base.route = o.route === 'orthogonal' || o.route === 'curved' ? o.route : 'straight';
    base.waypoints = Array.isArray(o.waypoints)
      ? o.waypoints
        .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      : undefined;
    base.w = 0; base.h = 0; // bbox derived from endpoints
  }
  if (base.type === 'pen') {
    base.points = Array.isArray(o.points) ? o.points.map((n) => num(n, 0)) : [];
    base.fill = null;
  }
  if (base.type === 'image') {
    base.src = typeof o.src === 'string' ? o.src : '';
    base.w = Math.max(num(o.w, 160), 8);
    base.h = Math.max(num(o.h, 160), 8);
  }
  if (base.type === 'icon') {
    base.slug = String(o.slug || 'icon');
    base.iconTitle = String(o.iconTitle || base.slug);
    base.iconPath = String(o.iconPath || '');
    base.brandColor = String(o.brandColor || '#888888');
  }
  return base;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Tolerant loader: never throws — bad/unknown entries are dropped so one
// corrupt diagram cannot break the whole note (requirement #49).
export function loadDiagram(json: unknown): DiagramData {
  let raw: any;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      return { v: DIAGRAM_VERSION, objects: [] };
    }
  } else {
    raw = json;
  }
  if (!raw || typeof raw !== 'object') return { v: DIAGRAM_VERSION, objects: [] };
  const list: any[] = Array.isArray(raw.objects) ? raw.objects.slice(0, 5000) : [];
  const defaults: ObjStyleDefaults = {
    stroke: '#9a9a9a', fill: null, strokeWidth: 2, dash: 'solid',
    textColor: '#e6e6e6', fontSize: 16,
  };
  const objects: DObj[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const t = item.type as ObjType;
    const known = isShape(t) || isConnector(t)
      || t === 'pen' || t === 'text' || t === 'image' || t === 'icon';
    if (!known) continue;
    try {
      objects.push(applyDefaults(item, defaults));
    } catch {
      // skip malformed entry
    }
  }
  return { v: DIAGRAM_VERSION, objects };
}

export function serializeDiagram(objects: DObj[]): string {
  return JSON.stringify({ v: DIAGRAM_VERSION, objects } satisfies DiagramData);
}
