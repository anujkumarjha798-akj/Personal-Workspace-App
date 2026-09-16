import { Extension } from '@tiptap/core';

export interface IndentOptions {
  types: string[];
  minLevel: number;
  maxLevel: number;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
    };
  }
}

// Adds a numeric `indent` attribute (0-8) to paragraphs/headings and renders
// it as left margin. List items use ProseMirror's native sink/lift instead.
export const Indent = Extension.create<IndentOptions>({
  name: 'indent',

  addOptions() {
    return { types: ['paragraph', 'heading'], minLevel: 0, maxLevel: 8 };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element: HTMLElement) => {
              const value = element.style.marginLeft;
              if (!value) return 0;
              return Math.round(parseInt(value, 10) / 24) || 0;
            },
            renderHTML: (attributes: { indent?: number }) => {
              if (!attributes.indent) return {};
              return { style: `margin-left: ${attributes.indent * 24}px` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      indentBlock:
        () =>
        ({ tr, state, dispatch }) => {
          const { selection } = state;
          const { $from, $to } = selection;
          let changed = false;
          state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (this.options.types.includes(node.type.name)) {
              const level = Math.min(this.options.maxLevel, (node.attrs.indent || 0) + 1);
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: level });
              changed = true;
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
      outdentBlock:
        () =>
        ({ tr, state, dispatch }) => {
          const { selection } = state;
          const { $from, $to } = selection;
          let changed = false;
          state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
            if (this.options.types.includes(node.type.name)) {
              const level = Math.max(this.options.minLevel, (node.attrs.indent || 0) - 1);
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: level });
              changed = true;
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.commands.sinkListItem('listItem')) return true;
        if (this.editor.commands.sinkListItem('taskItem')) return true;
        return this.editor.commands.indentBlock();
      },
      'Shift-Tab': () => {
        if (this.editor.commands.liftListItem('listItem')) return true;
        if (this.editor.commands.liftListItem('taskItem')) return true;
        return this.editor.commands.outdentBlock();
      },
    };
  },
});
