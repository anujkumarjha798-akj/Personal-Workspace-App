import { Mark, mergeAttributes } from '@tiptap/core';

export interface OverlineOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    overline: {
      setOverline: () => ReturnType;
      toggleOverline: () => ReturnType;
      unsetOverline: () => ReturnType;
    };
  }
}

export const Overline = Mark.create<OverlineOptions>({
  name: 'overline',

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [
      { style: 'text-decoration', getAttrs: (value) => (value as string).includes('overline') && null },
      { tag: 'span.overline' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: 'overline',
        style: 'text-decoration: overline; text-decoration-thickness: 1px;',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setOverline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleOverline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetOverline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-o': () => this.editor.commands.toggleOverline(),
    };
  },
});
