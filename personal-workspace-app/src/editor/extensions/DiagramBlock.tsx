// Tiptap integration: an atomic `diagram` block node. The full diagram is
// stored (JSON string) in the node's `diagram` attribute, so persistence rides
// entirely on the existing page-content path — autosave, Ctrl+S, workspace
// saves, backups and revisions all work unchanged.
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PencilRuler, Maximize2, TriangleAlert } from 'lucide-react';
import { loadDiagram, serializeDiagram, newObjId, type DObj } from '../diagram/types';
import { objectsBBox } from '../diagram/geometry';
import { ObjectNode } from '../diagram/DiagramCanvas';
import { DiagramEditor } from '../diagram/DiagramEditor';
import '../diagram/diagram.css';

function DiagramView({ node, updateAttributes, editor }: NodeViewProps) {
  const raw = (node.attrs.diagram as string) || '';
  const [open, setOpen] = useState(false);

  // Corrupt data must never take the note down (requirement #49).
  const { objects, broken } = useMemo(() => {
    if (!raw) return { objects: [] as DObj[], broken: false };
    try {
      const parsed = JSON.parse(raw);
      const data = loadDiagram(parsed);
      return { objects: data.objects, broken: false };
    } catch {
      return { objects: [] as DObj[], broken: true };
    }
  }, [raw]);

  const byId = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects]);

  const bbox = useMemo(() => {
    const b = objectsBBox(objects);
    if (!b) return null;
    const pad = 24;
    return {
      x: b.x - pad,
      y: b.y - pad,
      w: Math.max(b.w + pad * 2, 120),
      h: Math.max(b.h + pad * 2, 80),
    };
  }, [objects]);

  const onCommit = useCallback((json: string) => {
    updateAttributes({ diagram: json });
  }, [updateAttributes]);

  const openEditor = useCallback(() => {
    // Move focus out of ProseMirror so note-level shortcuts/deletes can't
    // fire while the whiteboard is open.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setOpen(false);
    editor.commands.focus();
  }, [editor]);

  return (
    <NodeViewWrapper className="dg-embed-wrap" contentEditable={false}
      onDoubleClick={(e: React.MouseEvent) => {
        e.preventDefault();
        openEditor();
      }}
    >
      <div className="dg-embed" data-diagram-empty={objects.length ? undefined : ''}>
        {broken ? (
          <div className="dg-embed-error">
            <TriangleAlert size={15} />
            Unable to load diagram — the rest of the note is unaffected.
          </div>
        ) : bbox ? (
          <svg
            viewBox={`${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`}
            className="dg-preview"
            preserveAspectRatio="xMidYMid meet"
            style={{
              // Never let a huge diagram take over the whole note: cap the
              // preview at ~1.15× its natural size and 500px tall.
              maxWidth: Math.min(1100, Math.ceil(bbox.w * 1.15)),
              maxHeight: 500,
            }}
          >
            {objects.map((o) => <ObjectNode key={o.id} o={o} byId={byId} />)}
          </svg>
        ) : (
          <div className="dg-embed-placeholder">
            <PencilRuler size={18} />
            <span>Empty diagram — double-click or press “Edit diagram”</span>
          </div>
        )}
        <button
          type="button"
          className="dg-edit-btn"
          title="Edit diagram (double-click)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            openEditor();
          }}
        >
          <Maximize2 size={13} />
          Edit diagram
        </button>
      </div>

      {open && createPortal(
        <DiagramEditor
          initialJson={serializeDiagram(objects)}
          onCommit={onCommit}
          onClose={closeEditor}
        />,
        document.body,
      )}
    </NodeViewWrapper>
  );
}

export interface InsertDiagramOptions {
  diagram?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    diagram: {
      insertDiagram: (options?: InsertDiagramOptions) => ReturnType;
    };
  }
}

// A friendly starting shape so a fresh diagram is immediately visible.
function starterShape(): DObj {
  return {
    id: newObjId(),
    type: 'roundrect',
    x: -80,
    y: -45,
    w: 160,
    h: 90,
    stroke: '#b9b9b9',
    fill: null,
    strokeWidth: 2,
    dash: 'solid',
    opacity: 100,
    fontSize: 16,
    textColor: '#e6e6e6',
    align: 'center',
    bold: false,
    italic: false,
    text: 'Double-click me',
  };
}

export const DiagramBlock = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      diagram: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-diagram') || '',
        renderHTML: (attributes) => ({ 'data-diagram': attributes.diagram || '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-diagram]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-diagram': '' }, HTMLAttributes)];
  },

  addCommands() {
    return {
      insertDiagram: (options?: InsertDiagramOptions) => ({ chain }) =>
        chain().insertContent({
          type: this.name,
          attrs: { diagram: options?.diagram ?? serializeDiagram([starterShape()]) },
        }).run(),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },
});
