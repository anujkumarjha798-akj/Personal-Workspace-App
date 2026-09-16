// Geometry + hit-testing helpers for the diagram editor (world coordinates).
import type { DObj } from './types';
import { isConnector } from './types';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Star vertices shared by the renderer and hit-testing so they always agree.
export function starPoints(w: number, h: number): [number, number][] {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) / 2;
  const inner = outer * 0.42;
  const kx = w / Math.min(w, h);
  const ky = h / Math.min(w, h);
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * r * kx, cy + Math.sin(a) * r * ky]);
  }
  return pts;
}

export function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number): { x: number; y: number } {
  if (!deg) return { x: px, y: py };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

function aabbOfRotated(b: BBox, deg: number): BBox {
  if (!deg || !b.w || !b.h) return b;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const corners = [
    rotatePoint(b.x, b.y, cx, cy, deg),
    rotatePoint(b.x + b.w, b.y, cx, cy, deg),
    rotatePoint(b.x + b.w, b.y + b.h, cx, cy, deg),
    rotatePoint(b.x, b.y + b.h, cx, cy, deg),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

export function objBBox(o: DObj): BBox {
  if (isConnector(o.type)) {
    const x1 = o.x;
    const y1 = o.y;
    const x2 = o.x2 ?? o.x;
    const y2 = o.y2 ?? o.y;
    let minX = Math.min(x1, x2);
    let minY = Math.min(y1, y2);
    let maxX = Math.max(x1, x2);
    let maxY = Math.max(y1, y2);
    for (const p of o.waypoints ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (o.type === 'pen') {
    const pts = o.points || [];
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    return { x: o.x + minX, y: o.y + minY, w: maxX - minX, h: maxY - minY };
  }
  return aabbOfRotated({ x: o.x, y: o.y, w: o.w, h: o.h }, o.rotation || 0);
}

export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function objectsBBox(objects: DObj[]): BBox | null {
  return unionBBox(objects.map(objBBox));
}

export function boxesIntersect(a: BBox, b: BBox): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function pointInBox(px: number, py: number, b: BBox, pad = 0): boolean {
  return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad;
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx;
  const ey = y1 + t * dy;
  return Math.hypot(px - ex, py - ey);
}

export interface HitContext {
  byId: Map<string, DObj>;
}

function localPoint(o: DObj, wx: number, wy: number): { lx: number; ly: number } {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const p = rotatePoint(wx, wy, cx, cy, -(o.rotation || 0));
  return { lx: p.x - o.x, ly: p.y - o.y };
}

function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// True when local point (lx,ly) is inside the shape's visual outline.
// Interior clicks always select — matching every mainstream whiteboard.
export function shapeContainsPoint(o: DObj, lx: number, ly: number): boolean {
  const { w, h } = o;
  switch (o.type) {
    case 'ellipse':
      if (!w || !h) return false;
      return ((lx - w / 2) / (w / 2)) ** 2 + ((ly - h / 2) / (h / 2)) ** 2 <= 1.06;
    case 'diamond':
      return pointInPolygon(lx, ly, [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'triangle':
      return pointInPolygon(lx, ly, [[w / 2, 0], [w, h], [0, h]]);
    case 'parallelogram': {
      const s = Math.min(24, w * 0.18);
      return pointInPolygon(lx, ly, [[s, 0], [w, 0], [w - s, h], [0, h]]);
    }
    case 'star':
      return pointInPolygon(lx, ly, starPoints(w, h));
    default:
      // rect, roundrect, terminator, cylinder, doc, preprocess
      return lx >= -2 && lx <= w + 2 && ly >= -2 && ly <= h + 2;
  }
}

// Returns true when world point (wx,wy) hits the object.
export function hitTest(o: DObj, wx: number, wy: number, ctx: HitContext): boolean {
  const pad = Math.max(4, (o.strokeWidth || 2));
  if (isConnector(o.type)) {
    // Test every segment of the resolved path so right-angle routes are
    // clickable along their bends too, not just the straight shortcut.
    const pts = connectorPolyline(o, ctx.byId);
    const tol = pad + 3;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (distToSegment(wx, wy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol) return true;
    }
    return false;
  }
  if (o.type === 'pen') {
    const pts = o.points || [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (distToSegment(wx, wy, o.x + pts[i], o.y + pts[i + 1], o.x + pts[i + 2], o.y + pts[i + 3]) <= pad + 2) {
        return true;
      }
    }
    if (pts.length === 2) return Math.hypot(wx - (o.x + pts[0]), wy - (o.y + pts[1])) <= pad + 2;
    return false;
  }
  if (o.type === 'text' || o.type === 'image' || o.type === 'icon') {
    const p = localPoint(o, wx, wy);
    return pointInBox(p.lx, p.ly, { x: 0, y: 0, w: o.w, h: o.h });
  }
  // Shapes: any click inside the outline selects the shape.
  const p = localPoint(o, wx, wy);
  return shapeContainsPoint(o, p.lx, p.ly);
}

// Topmost object under the point (objects rendered in array order; later = on top).
export function pickObject(objects: DObj[], wx: number, wy: number, byId: Map<string, DObj>): DObj | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    if (hitTest(objects[i], wx, wy, { byId })) return objects[i];
  }
  return null;
}

export function screenToWorld(sx: number, sy: number, cam: { tx: number; ty: number; scale: number }): { x: number; y: number } {
  return { x: (sx - cam.tx) / cam.scale, y: (sy - cam.ty) / cam.scale };
}

// ---- Connectors bound to shapes -------------------------------------------

function centerOf(byId: Map<string, DObj>, id: string | null | undefined): { x: number; y: number } | null {
  if (!id) return null;
  const s = byId.get(id);
  if (!s || isConnector(s.type)) return null;
  const b = { x: s.x, y: s.y, w: s.w, h: s.h };
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function rectEdgeIntersection(cx: number, cy: number, tx: number, ty: number, b: BBox): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = b.w / 2 || 1;
  const hh = b.h / 2 || 1;
  const scale = Math.min(
    dx !== 0 ? hw / Math.abs(dx) : Infinity,
    dy !== 0 ? hh / Math.abs(dy) : Infinity,
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

export type Side = 'n' | 'e' | 's' | 'w';

export type ConnectorEnd = 'start' | 'end';

// Midpoint of one edge of a box (the visible snap points).
export function sideMidpoint(b: BBox, s: Side): { x: number; y: number } {
  switch (s) {
    case 'n': return { x: b.x + b.w / 2, y: b.y };
    case 'e': return { x: b.x + b.w, y: b.y + b.h / 2 };
    case 's': return { x: b.x + b.w / 2, y: b.y + b.h };
    default: return { x: b.x, y: b.y + b.h / 2 };
  }
}

// Edge whose midpoint lies closest to the given point.
export function nearestSide(b: BBox, px: number, py: number): Side {
  const sides: Side[] = ['n', 'e', 's', 'w'];
  let best: Side = 'n';
  let bestD = Infinity;
  for (const s of sides) {
    const m = sideMidpoint(b, s);
    const d = (m.x - px) ** 2 + (m.y - py) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// Absolute position of a connector endpoint, honoring shape bindings and
// snapped anchor sides.
export function connectorEndPoint(o: DObj, which: ConnectorEnd, byId: Map<string, DObj>): { x: number; y: number } {
  const isStart = which === 'start';
  const freeX = isStart ? o.x : (o.x2 ?? o.x);
  const freeY = isStart ? o.y : (o.y2 ?? o.y);
  const bindId = isStart ? o.fromId : o.toId;
  const otherBindId = isStart ? o.toId : o.fromId;

  // Explicitly snapped side wins — the connector always touches that anchor.
  if (bindId) {
    const shape = byId.get(bindId);
    const side = isStart ? o.fromSide : o.toSide;
    if (shape && side && !isConnector(shape.type)) {
      return sideMidpoint({ x: shape.x, y: shape.y, w: shape.w, h: shape.h }, side);
    }
  }

  const target = centerOf(byId, bindId);
  if (!target) return { x: freeX, y: freeY };
  const shape = byId.get(bindId!);
  if (!shape) return { x: freeX, y: freeY };
  // Direction reference: the opposite endpoint (resolved one level).
  let refX: number;
  let refY: number;
  const otherCenter = centerOf(byId, otherBindId);
  if (otherCenter) {
    refX = otherCenter.x;
    refY = otherCenter.y;
  } else {
    refX = isStart ? (o.x2 ?? freeX + 1) : o.x;
    refY = isStart ? (o.y2 ?? freeY + 1) : o.y;
  }
  return rectEdgeIntersection(target.x, target.y, refX, refY, { x: shape.x, y: shape.y, w: shape.w, h: shape.h });
}

// Full visible path of a connector as a dense polyline (renderer AND
// hit-testing use this so they always agree).
//
// - straight:   start → waypoints → end, direct lines between each.
// - orthogonal: circuit-board right angles. Direction-aware: when an end is
//               bound to a shape side (n/s = vertical exit, e/w = horizontal)
//               the route leaves/enters along that side; otherwise the axis
//               with the larger gap wins. Waypoints become stair-step bends.
// - curved:     smooth Catmull-Rom S-curves through start, waypoints, end,
//               returned pre-sampled so polylines and hit-tests stay equal.
export function connectorPolyline(o: DObj, byId: Map<string, DObj>): { x: number; y: number }[] {
  const s = connectorEndPoint(o, 'start', byId);
  const e = connectorEndPoint(o, 'end', byId);
  const wps = (o.waypoints ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (o.route === 'curved') {
    return catmullRomSample([s, ...wps, e], 14);
  }

  if (o.route === 'orthogonal') {
    if (!wps.length) {
      const dx = Math.abs(e.x - s.x);
      const dy = Math.abs(e.y - s.y);
      if (dx < 1 || dy < 1) return [s, e];
      if (orthoPref(o) === 'h') {
        const midX = (s.x + e.x) / 2;
        return [s, { x: midX, y: s.y }, { x: midX, y: e.y }, e];
      }
      const midY = (s.y + e.y) / 2;
      return [s, { x: s.x, y: midY }, { x: e.x, y: midY }, e];
    }
    // Walk waypoint-to-waypoint, alternating bend orientation so segments
    // chain into clean stair-steps starting along the preferred axis.
    const out: { x: number; y: number }[] = [s];
    let dir = orthoPref(o);
    let prev = s;
    for (const wp of wps) {
      const bend = dir === 'h' ? { x: wp.x, y: prev.y } : { x: prev.x, y: wp.y };
      if (Math.hypot(bend.x - prev.x, bend.y - prev.y) > 0.5) out.push(bend);
      if (Math.hypot(wp.x - bend.x, wp.y - bend.y) > 0.5) out.push(wp);
      prev = wp;
      dir = dir === 'h' ? 'v' : 'h';
    }
    const bend = dir === 'h' ? { x: e.x, y: prev.y } : { x: prev.x, y: e.y };
    if (Math.hypot(bend.x - prev.x, bend.y - prev.y) > 0.5) out.push(bend);
    out.push(e);
    return out;
  }

  // straight
  return [s, ...wps, e];
}

// Preferred exit axis for orthogonal routing ('h' = horizontal first).
function orthoPref(o: DObj): 'h' | 'v' {
  const sideDir = (sd?: Side): 'h' | 'v' | null => (sd ? (sd === 'n' || sd === 's' ? 'v' : 'h') : null);
  const from = sideDir(o.fromSide);
  if (from) return from;
  const to = sideDir(o.toSide);
  if (to) return to;
  // Unbound ends: leave along whichever axis has more room.
  const dx = Math.abs((o.x2 ?? o.x) - o.x);
  const dy = Math.abs((o.y2 ?? o.y) - o.y);
  return dx >= dy ? 'h' : 'v';
}

// Smooth polyline through control points using Catmull-Rom splines
// (`per` samples per span). Endpoints are kept exact.
function catmullRomSample(pts: { x: number; y: number }[], per: number): { x: number; y: number }[] {
  if (pts.length < 3) return pts.slice();
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2];
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Point at half the total path length — where edge labels sit.
export function polylineMidpoint(pts: { x: number; y: number }[]): { x: number; y: number } {
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push(d);
    total += d;
  }
  let rem = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] > 0 && rem <= segs[i]) {
      const t = rem / segs[i];
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    rem -= segs[i];
  }
  return pts[Math.floor(pts.length / 2)] ?? { x: 0, y: 0 };
}

// Snap a dragged endpoint to the topmost shape under it (returns binding).
export function findShapeUnder(objects: DObj[], wx: number, wy: number, excludeIds: Set<string>): DObj | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (isConnector(o.type) || o.type === 'pen') continue;
    if (excludeIds.has(o.id)) continue;
    if (pointInBox(wx, wy, { x: o.x, y: o.y, w: o.w, h: o.h })) return o;
  }
  return null;
}

// Word-wrap estimation for plain <text> fallbacks (foreignObject wraps itself).
export function estimateTextHeight(text: string, widthPx: number, fontSize: number): number {
  const charsPerLine = Math.max(4, Math.floor(widthPx / (fontSize * 0.62)));
  let lines = 0;
  for (const raw of text.split('\n')) {
    lines += Math.max(1, Math.ceil(raw.length / charsPerLine));
  }
  return lines * fontSize * 1.45 + 8;
}
