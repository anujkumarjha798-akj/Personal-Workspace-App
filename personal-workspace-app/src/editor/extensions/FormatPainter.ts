import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Mark, Node as PMNode, NodeType } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';

/**
 * Format Painter (Word/Excel style).
 *
 * Copies the *formatting* of the current selection and re-applies it to a
 * later selection without ever touching the target's text, images, tables or
 * other nodes. Everything happens inside a single ProseMirror transaction so
 * undo/redo treat one paint as one step.
 *
 * Only formatting this editor actually supports is copied:
 *   marks  - bold, italic, underline, strike, code, overline,
 *            textStyle (color + fontSize), highlight
 *   blocks - paragraph/heading type (incl. heading level), textAlign, indent
 *
 * Deliberately NOT copied:
 *   link   - copying it would turn plain target text into the source's link,
 *            so existing target links are left exactly as they are.
 */

export interface CapturedMark {
  type: string;
  attrs: Record<string, unknown>;
}

export interface CapturedFormat {
  marks: CapturedMark[];
  blockType: string | null;
  blockAttrs: Record<string, unknown>;
}

export interface FormatPainterState {
  active: boolean;
  sticky: boolean;
  format: CapturedFormat | null;
}

const IDLE: FormatPainterState = { active: false, sticky: false, format: null };

// Marks the painter owns: these are cleared on the target before the copied
// ones are applied, so "no bold in source" really means "no bold in target".
const PAINTABLE_MARKS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'overline',
  'textStyle',
  'highlight',
];

// Block types whose formatting attributes may be painted.
const PAINTABLE_BLOCKS = ['paragraph', 'heading'];

export const formatPainterKey = new PluginKey<FormatPainterState>('formatPainter');

export function getFormatPainterState(state: EditorState): FormatPainterState {
  return formatPainterKey.getState(state) ?? IDLE;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    formatPainter: {
      /** Capture the formatting of the current selection and arm the painter. */
      copyFormat: (sticky?: boolean) => ReturnType;
      /** Keep the painter armed after a paint (double-click behaviour). */
      setFormatPainterSticky: (sticky: boolean) => ReturnType;
      /** Disarm the painter and drop the captured formatting. */
      stopFormatPainter: () => ReturnType;
      /** Apply the captured formatting to the current selection. */
      applyCopiedFormat: () => ReturnType;
    };
  }
}

function setPainter(tr: Transaction, next: FormatPainterState): Transaction {
  return tr.setMeta(formatPainterKey, next);
}

export function captureFormat(state: EditorState): CapturedFormat | null {
  const { selection, storedMarks, doc } = state;
  const { $from, from, to, empty } = selection;

  let marks: readonly Mark[] = [];
  if (empty) {
    marks = storedMarks ?? $from.marks();
  } else {
    let found: readonly Mark[] | null = null;
    doc.nodesBetween(from, to, (node) => {
      if (!found && node.isText) found = node.marks;
      return !found;
    });
    marks = found ?? $from.marks();
  }

  const painted = marks
    .filter((mark) => PAINTABLE_MARKS.includes(mark.type.name))
    .map((mark) => ({ type: mark.type.name, attrs: { ...mark.attrs } }));

  let blockType: string | null = null;
  let blockAttrs: Record<string, unknown> = {};
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (node.isTextblock) {
      if (PAINTABLE_BLOCKS.includes(node.type.name)) {
        blockType = node.type.name;
        blockAttrs = { ...node.attrs };
      }
      break;
    }
  }

  if (!painted.length && !blockType) return null;
  return { marks: painted, blockType, blockAttrs };
}

/** Textblocks the paint should touch, as { pos, node } pairs. */
function targetBlocks(state: EditorState): { pos: number; node: PMNode }[] {
  const { selection, doc } = state;
  const out: { pos: number; node: PMNode }[] = [];

  if (selection.empty) {
    const { $from } = selection;
    for (let depth = $from.depth; depth >= 1; depth--) {
      const node = $from.node(depth);
      if (node.isTextblock) {
        if (PAINTABLE_BLOCKS.includes(node.type.name)) out.push({ pos: $from.before(depth), node });
        break;
      }
    }
    return out;
  }

  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.isTextblock && PAINTABLE_BLOCKS.includes(node.type.name)) out.push({ pos, node });
  });
  return out;
}

function mergedBlockAttrs(
  type: NodeType,
  nodeAttrs: Record<string, unknown>,
  sourceAttrs: Record<string, unknown>,
): Record<string, unknown> {
  const spec = type.spec.attrs ?? {};
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    if (key in sourceAttrs) next[key] = sourceAttrs[key];
    else if (key in nodeAttrs) next[key] = nodeAttrs[key];
    else next[key] = spec[key].default;
  }
  return next;
}

export function applyFormat(state: EditorState, format: CapturedFormat, tr: Transaction): boolean {
  const { schema, selection } = state;
  const { from, to, empty } = selection;
  let changed = false;

  if (!empty) {
    // Clear only the marks the painter owns — links, and anything else the
    // editor may add later, survive untouched.
    for (const name of PAINTABLE_MARKS) {
      const type = schema.marks[name];
      if (type) tr.removeMark(from, to, type);
    }
    for (const mark of format.marks) {
      const type = schema.marks[mark.type];
      if (!type) continue;
      tr.addMark(from, to, type.create(mark.attrs));
    }
    changed = true;
  } else {
    // No selection: arm the marks for whatever the user types next instead of
    // rewriting any existing text.
    const stored = format.marks
      .map((mark) => {
        const type = schema.marks[mark.type];
        return type ? type.create(mark.attrs) : null;
      })
      .filter((mark): mark is Mark => !!mark);
    tr.setStoredMarks(stored);
  }

  const sourceType = format.blockType ? schema.nodes[format.blockType] : null;
  if (sourceType) {
    for (const { pos, node } of targetBlocks(state)) {
      let nextType = node.type;
      if (sourceType !== node.type) {
        const $pos = tr.doc.resolve(pos);
        const index = $pos.index();
        // Only switch paragraph <-> heading where the parent allows it, so
        // list items, table cells and similar structures stay valid.
        if ($pos.parent.canReplaceWith(index, index + 1, sourceType)) nextType = sourceType;
      }
      const attrs = mergedBlockAttrs(nextType, node.attrs, format.blockAttrs);
      tr.setNodeMarkup(pos, nextType === node.type ? undefined : nextType, attrs, node.marks);
      changed = true;
    }
  }

  return changed;
}

export const FormatPainter = Extension.create({
  name: 'formatPainter',

  addCommands() {
    return {
      copyFormat:
        (sticky = false) =>
        ({ state, tr, dispatch }) => {
          const format = captureFormat(state);
          if (!format) return false;
          if (dispatch) dispatch(setPainter(tr, { active: true, sticky, format }));
          return true;
        },

      setFormatPainterSticky:
        (sticky: boolean) =>
        ({ state, tr, dispatch }) => {
          const current = getFormatPainterState(state);
          if (!current.active) return false;
          if (dispatch) dispatch(setPainter(tr, { ...current, sticky }));
          return true;
        },

      stopFormatPainter:
        () =>
        ({ state, tr, dispatch }) => {
          if (!getFormatPainterState(state).active) return false;
          if (dispatch) dispatch(setPainter(tr, { ...IDLE }));
          return true;
        },

      applyCopiedFormat:
        () =>
        ({ state, tr, dispatch }) => {
          const current = getFormatPainterState(state);
          if (!current.active || !current.format) return false;
          if (!dispatch) return true;
          // Start a fresh history group so one paint is always exactly one undo.
          closeHistory(tr);
          const ok = applyFormat(state, current.format, tr);
          if (!current.sticky) setPainter(tr, { ...IDLE });
          if (ok || !current.sticky) dispatch(tr);
          return ok;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Escape: () => this.editor.commands.stopFormatPainter(),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: formatPainterKey,
        state: {
          init: (): FormatPainterState => ({ ...IDLE }),
          apply(tr, value): FormatPainterState {
            const meta = tr.getMeta(formatPainterKey) as FormatPainterState | undefined;
            return meta ? meta : value;
          },
        },
        props: {
          attributes(state): Record<string, string> {
            return getFormatPainterState(state).active ? { class: 'format-painter-active' } : {};
          },
          handleDOMEvents: {
            mouseup: (view) => {
              if (!getFormatPainterState(view.state).active) return false;
              // Let the browser finish settling the new selection first.
              window.setTimeout(() => {
                if (!editor.isDestroyed) editor.commands.applyCopiedFormat();
              }, 0);
              return false;
            },
          },
        },
      }),
    ];
  },
});
