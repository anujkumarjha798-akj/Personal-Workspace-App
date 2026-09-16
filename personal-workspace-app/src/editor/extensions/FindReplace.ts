import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface FindReplaceStorage {
  query: string;
  matches: { from: number; to: number }[];
  activeIndex: number;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

// Tiptap v3 types `editor.storage` per-extension via module augmentation
// instead of an open-ended `Record<string, any>`, so `findReplace` needs to
// be declared here for `editor.storage.findReplace` to type-check elsewhere
// (e.g. FindBar.tsx).
declare module '@tiptap/core' {
  interface Storage {
    findReplace: FindReplaceStorage;
  }
}

export const findReplacePluginKey = new PluginKey('findReplace');

const MAX_REGEX_LENGTH = 100;

// Guards against catastrophic-backtracking patterns (ReDoS) that could freeze
// the tab. Patterns that are too long, contain nested quantifiers like
// `(a+)+`, or huge `{m,n}` ranges fall back to literal matching.
function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  if (/\([^()]*[+*]\s*\)\s*[+*?{]/.test(pattern)) return false;
  if (/\{\d{4,}\}/.test(pattern) || /\{\s*\d+\s*,\s*\d{4,}\}/.test(pattern)) return false;
  return true;
}

function buildMatches(
  doc: import('@tiptap/pm/model').Node,
  query: string,
  matchCase: boolean,
  wholeWord: boolean,
  useRegex: boolean
): { from: number; to: number }[] {
  if (!query) return [];
  const matches: { from: number; to: number }[] = [];
  let pattern: RegExp;
  try {
    if (useRegex && isSafeRegexPattern(query)) {
      pattern = new RegExp(query, matchCase ? 'g' : 'gi');
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const source = wholeWord ? `\\b${escaped}\\b` : escaped;
      pattern = new RegExp(source, matchCase ? 'g' : 'gi');
    }
  } catch {
    return [];
  }

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      matches.push({ from: pos + match.index, to: pos + match.index + match[0].length });
    }
  });
  return matches;
}

export const FindReplace = Extension.create({
  name: 'findReplace',

  addStorage(): FindReplaceStorage {
    return { query: '', matches: [], activeIndex: 0, matchCase: false, wholeWord: false, useRegex: false };
  },

  addCommands(): any {
    return {
      setFindQuery:
        (query: string, opts?: { matchCase?: boolean; wholeWord?: boolean; useRegex?: boolean }) =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          storage.query = query;
          if (opts) Object.assign(storage, opts);
          storage.matches = buildMatches(tr.doc, query, storage.matchCase, storage.wholeWord, storage.useRegex);
          storage.activeIndex = storage.matches.length ? 0 : -1;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
      findNext:
        () =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (!storage.matches.length) return false;
          storage.activeIndex = (storage.activeIndex + 1) % storage.matches.length;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
      findPrev:
        () =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (!storage.matches.length) return false;
          storage.activeIndex = (storage.activeIndex - 1 + storage.matches.length) % storage.matches.length;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
      replaceActive:
        (replacement: string) =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          if (storage.activeIndex < 0 || !storage.matches[storage.activeIndex]) return false;
          const m = storage.matches[storage.activeIndex];
          tr.insertText(replacement, m.from, m.to);
          storage.matches = buildMatches(tr.doc, storage.query, storage.matchCase, storage.wholeWord, storage.useRegex);
          if (storage.matches.length) storage.activeIndex = storage.activeIndex % storage.matches.length;
          else storage.activeIndex = -1;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
      replaceAll:
        (replacement: string) =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          let matches = buildMatches(tr.doc, storage.query, storage.matchCase, storage.wholeWord, storage.useRegex);
          // Replace from the end so earlier positions stay valid.
          for (let i = matches.length - 1; i >= 0; i--) {
            tr.insertText(replacement, matches[i].from, matches[i].to);
          }
          storage.matches = [];
          storage.activeIndex = -1;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
      clearFind:
        () =>
        ({ editor, tr, dispatch }: { editor: any; tr: any; dispatch: any }) => {
          const storage = editor.storage.findReplace as FindReplaceStorage;
          storage.query = '';
          storage.matches = [];
          storage.activeIndex = -1;
          if (dispatch) dispatch(tr.setMeta(findReplacePluginKey, true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const extensionThis = this;
    return [
      new Plugin({
        key: findReplacePluginKey,
        props: {
          decorations: () => {
            const storage = extensionThis.editor.storage.findReplace as FindReplaceStorage;
            if (!storage.matches.length) return null;
            const decorations = storage.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === storage.activeIndex ? 'find-match find-match-active' : 'find-match',
              })
            );
            return DecorationSet.create(extensionThis.editor.state.doc, decorations);
          },
        },
      }),
    ];
  },
});
