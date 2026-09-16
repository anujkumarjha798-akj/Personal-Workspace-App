// Shared SVG renderer for diagram objects. Used by both the embedded preview
// in the note and the fullscreen editor canvas so they always look identical.
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { DObj } from './types';
import { connectorPolyline, polylineMidpoint, starPoints } from './geometry';
import { toImageUrl } from '../../services/api';

// SVG <image> with an explicit error state — a broken/missing attachment can
// never render as a silent blank box. Both href and xlink:href are set for
// maximum browser compatibility.
function DiagramImage({ o }: { o: DObj }) {
  const [failed, setFailed] = useState(false);
  if (failed || !o.src) {
    return (
      <g>
        <rect
          x={o.x} y={o.y} width={o.w} height={o.h}
          fill="none" stroke="#e06c60" strokeDasharray="6 4"
          strokeWidth={1.5} rx={4}
        />
        <text x={o.x + o.w / 2} y={o.y + o.h / 2 + 4} textAnchor="middle"
          fontSize={Math.min(13, o.h / 3)} fill="#e06c60">
          Image unavailable
        </text>
      </g>
    );
  }
  const url = toImageUrl(o.src);
  return (
    <image
      href={url}
      xlinkHref={url}
      x={o.x}
      y={o.y}
      width={o.w}
      height={o.h}
      preserveAspectRatio="xMidYMid meet"
      onError={() => setFailed(true)}
    />
  );
}

const DASH: Record<string, string | undefined> = {
  solid: undefined,
  dashed: '10 7',
  dotted: '0.1 8',
};

function strokeAttrs(o: DObj) {
  return {
    stroke: o.stroke || '#9a9a9a',
    strokeWidth: o.strokeWidth || 2,
    strokeDasharray: DASH[o.dash || 'solid'],
    strokeLinecap: o.dash === 'dotted' ? ('round' as const) : ('butt' as const),
    fill: undefined as string | undefined,
  };
}

// Shape outline geometry in LOCAL coordinates (origin = object x,y).
export function shapeGeometry(o: DObj): ReactNode {
  const { w, h } = o;
  switch (o.type) {
    case 'rect':
      return <rect x={0} y={0} width={w} height={h} />;
    case 'roundrect':
    case 'terminator':
      return <rect x={0} y={0} width={w} height={h} rx={o.type === 'terminator' ? h / 2 : Math.min(12, h / 4)} />;
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />;
    case 'diamond':
      return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />;
    case 'triangle':
      return <polygon points={`${w / 2},0 ${w},${h} 0,${h}`} />;
    case 'star':
      return <polygon points={starPointsStr(w, h)} />;
    case 'parallelogram': {
      const s = Math.min(24, w * 0.18);
      return <polygon points={`${s},0 ${w},0 ${w - s},${h} 0,${h}`} />;
    }
    case 'preprocess': {
      const inset = Math.min(16, w * 0.14);
      return (
        <>
          <rect x={0} y={0} width={w} height={h} />
          <line x1={inset} y1={0} x2={inset} y2={h} fill="none" />
          <line x1={w - inset} y1={0} x2={w - inset} y2={h} fill="none" />
        </>
      );
    }
    case 'cylinder': {
      const ry = Math.max(6, Math.min(h * 0.14, 18));
      return (
        <>
          <path d={`M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} L${w},${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`} />
          <ellipse cx={w / 2} cy={ry} rx={w / 2} ry={ry} fill="none" />
        </>
      );
    }
    case 'doc': {
      const wave = Math.max(6, Math.min(h * 0.14, 18));
      return (
        <path d={`M0,0 L${w},0 L${w},${h - wave} Q${w * 0.75},${h - wave * 2.2} ${w * 0.5},${h - wave} T0,${h - wave} Z`} />
      );
    }
    default:
      return <rect x={0} y={0} width={w} height={h} />;
  }
}

// Star vertices shared by the renderer and hit-testing so they always agree.
function starPointsStr(w: number, h: number): string {
  return starPoints(w, h).map((p) => `${p[0]},${p[1]}`).join(' ');
}

function arrowHeadPoly(tipX: number, tipY: number, fromX: number, fromY: number, size: number): string {
  const a = Math.atan2(tipY - fromY, tipX - fromX);
  const spread = 0.46;
  const p1x = tipX - size * Math.cos(a - spread);
  const p1y = tipY - size * Math.sin(a - spread);
  const p2x = tipX - size * Math.cos(a + spread);
  const p2y = tipY - size * Math.sin(a + spread);
  return `${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}`;
}

function Connector({ o, byId }: { o: DObj; byId: Map<string, DObj> }) {
  const pts = connectorPolyline(o, byId);
  const sa = strokeAttrs(o);
  const sw = o.strokeWidth || 2;
  const headSize = Math.max(9, sw * 3.6);
  const n = pts.length;
  const start = pts[0];
  const end = pts[n - 1];
  // Head orientation follows the first/last SEGMENT direction of travel
  // (forward, i.e. pointing AWAY from the line) so right-angle and curved
  // routes get correctly pointing arrowheads.
  const startDir = Math.atan2(pts[1].y - start.y, pts[1].x - start.x);
  const endDir = Math.atan2(end.y - pts[n - 2].y, end.x - pts[n - 2].x);

  let sx = start.x;
  let sy = start.y;
  let ex = end.x;
  let ey = end.y;
  const endHead = o.endArrow ?? (o.type === 'arrow' ? 'arrow' : 'none');
  if (endHead === 'arrow') {
    // Shorten the line so it doesn't poke through the head.
    ex -= Math.cos(endDir) * headSize * 0.85;
    ey -= Math.sin(endDir) * headSize * 0.85;
  }
  const startHead = o.startArrow ?? 'none';
  if (startHead === 'arrow') {
    sx += Math.cos(startDir) * headSize * 0.85;
    sy += Math.sin(startDir) * headSize * 0.85;
  }

  // Draw the full route with the first/last points pulled in for arrowheads.
  const drawn = pts.map((p) => ({ ...p }));
  drawn[0] = { x: sx, y: sy };
  drawn[n - 1] = { x: ex, y: ey };

  return (
    <g>
      <polyline
        points={drawn.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={sa.stroke} strokeWidth={sa.strokeWidth}
        strokeDasharray={sa.strokeDasharray}
        strokeLinecap={o.dash === 'dotted' ? 'round' : 'butt'}
        strokeLinejoin={o.route === 'curved' ? 'round' : 'miter'}
      />
      {endHead !== 'none' && (
        endHead === 'circle'
          ? <circle cx={end.x} cy={end.y} r={Math.max(3.5, sw * 1.7)} fill={o.stroke} />
          : <polygon points={arrowHeadPoly(end.x, end.y, ex, ey, headSize)} fill={o.stroke} />
      )}
      {startHead !== 'none' && (
        startHead === 'circle'
          ? <circle cx={start.x} cy={start.y} r={Math.max(3.5, sw * 1.7)} fill={o.stroke} />
          : <polygon points={arrowHeadPoly(start.x, start.y, sx, sy, headSize)} fill={o.stroke} />
      )}
      {/* Edge label (Yes/No on decision branches…) sits at the path midpoint. */}
      {o.text ? (() => {
        const mid = polylineMidpoint(pts);
        return (
          <foreignObject x={mid.x - 90} y={mid.y - 16} width={180} height={32}>
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: o.textColor || '#e6e6e6',
              fontSize: `${o.fontSize || 13}px`,
              fontWeight: o.bold ? 700 : 400,
              fontStyle: o.italic ? 'italic' : 'normal',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              whiteSpace: 'pre-wrap', textAlign: 'center',
              background: 'var(--bg-elevated)', borderRadius: 4,
              padding: '0 4px', pointerEvents: 'none', userSelect: 'none',
            }}>{o.text}</div>
          </foreignObject>
        );
      })() : null}
    </g>
  );
}

function PenPath({ o }: { o: DObj }) {
  const pts = o.points || [];
  if (!pts.length) return null;
  let d = `M${o.x + pts[0]},${o.y + pts[1]}`;
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const mx = o.x + (pts[i - 2] + pts[i]) / 2;
    const my = o.y + (pts[i - 1] + pts[i + 1]) / 2;
    d += ` Q${o.x + pts[i - 2]},${o.y + pts[i - 1]} ${mx},${my}`;
  }
  d += ` L${o.x + pts[pts.length - 2]},${o.y + pts[pts.length - 1]}`;
  return (
    <path d={d} fill="none"
      stroke={o.stroke || '#9a9a9a'} strokeWidth={o.strokeWidth || 2}
      strokeDasharray={DASH[o.dash || 'solid']}
      strokeLinejoin="round" strokeLinecap="round" />
  );
}

function textDivStyle(o: DObj): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: o.align === 'left' ? 'flex-start' : o.align === 'right' ? 'flex-end' : 'center',
    width: '100%',
    height: '100%',
    padding: '4px 6px',
    boxSizing: 'border-box',
    color: o.textColor || '#e6e6e6',
    fontSize: `${o.fontSize || 16}px`,
    fontWeight: o.bold ? 700 : 400,
    fontStyle: o.italic ? 'italic' : 'normal',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    textAlign: o.align || 'center',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.35,
    overflow: 'hidden',
    pointerEvents: 'none',
    userSelect: 'none',
  };
}

// Inline content with per-run formatting when rich segments exist (pasted
// from the note editor), otherwise the plain string.
function textContent(o: DObj): ReactNode {
  if (!o.rich?.length) return o.text;
  return o.rich.map((seg, idx) => (
    <span
      key={idx}
      style={{
        fontWeight: seg.b ? 700 : undefined,
        fontStyle: seg.i ? 'italic' : undefined,
        color: seg.c || undefined,
        fontSize: seg.s ? `${seg.s}px` : undefined,
      }}
    >
      {seg.t}
    </span>
  ));
}

function ObjText({ o }: { o: DObj }) {
  if (!o.text) return null;
  return (
    <foreignObject x={0} y={0} width={o.w} height={o.h}>
      <div style={textDivStyle(o)}>{textContent(o)}</div>
    </foreignObject>
  );
}

// Renders one diagram object into SVG. Exported so the editor can draw drafts
// and selection overlays with exactly the same appearance as previews.
export function ObjectNode({ o, byId }: { o: DObj; byId: Map<string, DObj> }) {
  const opacity = (o.opacity ?? 100) / 100;
  const transform = o.rotation
    ? `rotate(${o.rotation} ${o.x + o.w / 2} ${o.y + o.h / 2})`
    : undefined;

  let body: ReactNode;
  if (o.type === 'arrow' || o.type === 'line') {
    body = <Connector o={o} byId={byId} />;
  } else if (o.type === 'pen') {
    body = <PenPath o={o} />;
  } else if (o.type === 'image') {
    // Attachment refs are resolved to same-origin URLs at render time.
    body = <DiagramImage o={o} />;
  } else if (o.type === 'icon') {
    body = (
      <g>
        <svg viewBox="0 0 24 24" x={o.x} y={o.y} width={o.w} height={o.h} overflow="visible">
          <path d={o.iconPath || ''} fill={o.brandColor || '#888888'} />
        </svg>
        {o.text ? (
          <foreignObject x={o.x - o.w} y={o.y + o.h + 3} width={o.w * 3} height={24}>
            <div style={{ ...textDivStyle({ ...o, align: 'center' }), height: 20 }}>{o.text}</div>
          </foreignObject>
        ) : null}
      </g>
    );
  } else if (o.type === 'text') {
    body = (
      <foreignObject x={o.x} y={o.y} width={o.w} height={o.h}>
        <div style={textDivStyle(o)}>{textContent(o)}</div>
      </foreignObject>
    );
  } else {
    body = (
      <g transform={`translate(${o.x} ${o.y})`}>
        <g {...strokeAttrs(o)} fill={o.fill && o.fill !== 'none' ? o.fill : 'none'}>
          {shapeGeometry(o)}
        </g>
        <ObjText o={o} />
      </g>
    );
  }

  return (
    <g transform={transform} opacity={opacity} data-obj-id={o.id}>
      {body}
    </g>
  );
}

// Renders every object — used for static previews.
export function DiagramCanvas({ objects }: { objects: DObj[] }) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return (
    <>
      {objects.map((o) => <ObjectNode key={o.id} o={o} byId={byId} />)}
    </>
  );
}
