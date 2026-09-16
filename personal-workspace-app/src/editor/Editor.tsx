import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { Page, SaveStatus, OutlineHeading } from '../types';
import { editorExtensions } from './extensions';
import { Toolbar } from './Toolbar';
import { FindBar } from './FindBar';
import { updatePage } from '../db/pages';
import { sanitizePastedHtml } from './pasteSanitize';
import { api, attachmentExtFromMime, canonicalizeImageSrc } from '../services/api';
import { uploadAttachmentFiles } from './attachments';

interface EditorProps {
  page: Page;
  breadcrumb: string;
  onStatusChange: (status: SaveStatus) => void;
  onOutlineChange: (headings: OutlineHeading[]) => void;
  onStatsChange: (stats: { words: number; chars: number }) => void;
  onTitleChange: (title: string) => void;
  // Handed a function that scrolls the editor to a given heading position.
  // Called whenever the underlying editor instance (re)mounts, so the
  // parent always has a live navigator for the currently open page.
  onNavigatorReady?: (navigate: (pos: number) => void) => void;
  // Reports which outline heading is currently active (the one at/near the
  // caret, or the last one scrolled past), so the Outline panel can
  // highlight it like a table of contents.
  onActiveHeadingChange?: (pos: number | null) => void;
}

function normalizeContent(content: string): any {
  let json: any;
  try {
    json = JSON.parse(content);
  } catch {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      node.attrs.src = canonicalizeImageSrc(node.attrs.src);
    }
    (node.content || []).forEach(walk);
  };
  walk(json);
  return json;
}

async function uploadImageToAttachment(file: File): Promise<string> {
  const { name } = await api.uploadAttachment(file, attachmentExtFromMime(file.type));
  return `attachments/${name}`;
}

// Walk the live ProseMirror document (not the serialized JSON) so every
// heading comes with its exact absolute position. That position is what
// makes each Outline entry map to one specific heading node — including
// when two headings share identical text — rather than to a text match.
function extractOutline(doc: import('@tiptap/pm/model').Node): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const text = node.textContent;
      if (text) out.push({ level: node.attrs.level || 1, text, pos });
      return false; // headings have inline content only; no need to descend further
    }
    return true;
  });
  return out;
}

export function DocEditor({ page, breadcrumb, onStatusChange, onOutlineChange, onStatsChange, onTitleChange, onNavigatorReady, onActiveHeadingChange }: EditorProps) {
  const [title, setTitle] = useState(page.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findReplaceMode, setFindReplaceMode] = useState(false);
  const saveTimeout = useRef<number | null>(null);
  const statusRef = useRef<SaveStatus>('saved');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Latest outline, kept in a ref so the scroll listener can read current
  // heading positions without needing to be re-attached on every edit.
  const outlineRef = useRef<OutlineHeading[]>([]);
  const scrollRafRef = useRef<number | null>(null);

  const editor = useEditor({
    extensions: editorExtensions,
    content: normalizeContent(page.content),
    autofocus: false,
    editorProps: {
      handlePaste: (view, event) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        // Prefer rich HTML (from ChatGPT, Word, Google Docs, or a browser page)
        // over plain text so headings, bold/italic, lists, links, tables, and
        // code blocks survive the paste. Falls through to ProseMirror's normal
        // text/plain handling when no usable HTML is present.
        const html = clipboardData.getData('text/html');
        if (html && html.trim()) {
          const sanitized = sanitizePastedHtml(html);
          if (sanitized.trim()) {
            event.preventDefault();
            const dom = new window.DOMParser().parseFromString(sanitized, 'text/html');
            const parser = PMDOMParser.fromSchema(view.state.schema);
            const slice = parser.parseSlice(dom.body, { preserveWhitespace: true });
            const { state, dispatch } = view;
            dispatch(state.tr.replaceSelection(slice).scrollIntoView());
            return true;
          }
        }

        const items = clipboardData.items;
        if (!items) return false;
        const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
        if (!imageItem) return false;
        const file = imageItem.getAsFile();
        if (!file) return false;
        event.preventDefault();
        uploadImageToAttachment(file).then((src) => {
          const { schema } = view.state;
          const node = schema.nodes.image.create({ src });
          const transaction = view.state.tr.replaceSelectionWith(node);
          view.dispatch(transaction);
        }).catch((err) => {
          console.error('Image upload failed:', err);
        });
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files || !files.length) return false;
        const imageFiles = files.filter((f) => f.type.startsWith('image/'));
        const otherFiles = files.filter((f) => !f.type.startsWith('image/'));
        if (!imageFiles.length && !otherFiles.length) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        let insertPos = coords ? coords.pos : view.state.selection.to;
        (async () => {
          for (const file of imageFiles) {
            try {
              const src = await uploadImageToAttachment(file);
              const { schema } = view.state;
              const node = schema.nodes.image.create({ src });
              const transaction = view.state.tr.insert(insertPos, node);
              view.dispatch(transaction);
              insertPos += 1;
            } catch (err) {
              console.error('Image upload failed:', err);
            }
          }
          if (otherFiles.length) {
            try {
              const uploaded = await uploadAttachmentFiles(otherFiles);
              if (uploaded?.length) {
                const { schema } = view.state;
                let tr = view.state.tr;
                for (const file of uploaded) {
                  tr = tr.insert(insertPos, schema.nodes.fileAttachment.create({ name: file.name, title: file.title || file.name }));
                  insertPos += 1;
                }
                view.dispatch(tr);
              }
            } catch (err) {
              console.error('Attachment upload failed:', err);
            }
          }
        })();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      statusRef.current = 'editing';
      onStatusChange('editing');
      const json = editor.getJSON();
      const outline = extractOutline(editor.state.doc);
      outlineRef.current = outline;
      onOutlineChange(outline);
      onStatsChange({
        words: editor.storage.characterCount.words(),
        chars: editor.storage.characterCount.characters(),
      });
      if (saveTimeout.current) window.clearTimeout(saveTimeout.current);
      saveTimeout.current = window.setTimeout(async () => {
        onStatusChange('saving');
        try {
          await updatePage(page.id, { content: JSON.stringify(json) });
          onStatusChange('saved');
        } catch {
          onStatusChange('error');
        }
      }, 700);
    },
  }, [page.id]);

  useEffect(() => {
    setTitle(page.title);
  }, [page.id, page.title]);

  useEffect(() => {
    if (editor) {
      const outline = extractOutline(editor.state.doc);
      outlineRef.current = outline;
      onOutlineChange(outline);
      onStatsChange({
        words: editor.storage.characterCount.words(),
        chars: editor.storage.characterCount.characters(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Scrolls the editor to a specific heading position and places the caret
  // there. Uses the editor's own node-to-DOM mapping (not a text search) so
  // it always lands on the exact heading that was clicked, even when other
  // headings have identical text.
  const navigateToHeading = useCallback((pos: number) => {
    if (!editor) return;
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    if (dom && typeof dom.scrollIntoView === 'function') {
      dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    try {
      const size = editor.state.doc.content.size;
      const $pos = editor.state.doc.resolve(Math.min(pos + 1, size));
      const tr = editor.state.tr.setSelection(TextSelection.near($pos));
      editor.view.dispatch(tr);
    } catch {
      // Position no longer valid (doc changed underneath); scrolling above
      // already succeeded, so there's nothing else to do.
    }
    onActiveHeadingChange?.(pos);
  }, [editor, onActiveHeadingChange]);

  useEffect(() => {
    onNavigatorReady?.(navigateToHeading);
  }, [navigateToHeading, onNavigatorReady]);

  // Scroll-spy: as the user scrolls the document manually, keep the Outline
  // panel's highlighted item in sync with whichever heading is currently at
  // (or just above) the top of the visible editor area — like a live table
  // of contents. Throttled to one check per animation frame, and only reads
  // the small set of already-known heading nodes (no document scanning).
  useEffect(() => {
    const container = scrollRef.current;
    if (!editor || !container) return;

    const computeActive = () => {
      const containerTop = container.getBoundingClientRect().top;
      const threshold = containerTop + 32;
      let candidate: number | null = null;
      for (const heading of outlineRef.current) {
        const dom = editor.view.nodeDOM(heading.pos) as HTMLElement | null;
        if (!dom) continue;
        const top = dom.getBoundingClientRect().top;
        if (top <= threshold) {
          candidate = heading.pos;
        } else {
          break;
        }
      }
      onActiveHeadingChange?.(candidate);
    };

    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        computeActive();
      });
    };

    computeActive();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const commitTitle = useCallback(async () => {
    setEditingTitle(false);
    const trimmed = title.trim() || 'Untitled';
    setTitle(trimmed);
    onTitleChange(trimmed);
    await updatePage(page.id, { title: trimmed });
  }, [title, page.id, onTitleChange]);

  const forceSave = useCallback(async () => {
    if (!editor) return;
    if (saveTimeout.current) window.clearTimeout(saveTimeout.current);
    onStatusChange('saving');
    try {
      await updatePage(page.id, { content: JSON.stringify(editor.getJSON()), title });
      onStatusChange('saved');
    } catch {
      onStatusChange('error');
    }
  }, [editor, page.id, title, onStatusChange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        forceSave();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindReplaceMode(false);
        setFindOpen(true);
      } else if (mod && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setFindReplaceMode(true);
        setFindOpen(true);
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [forceSave, findOpen]);

  useEffect(() => {
    return () => {
      if (saveTimeout.current) window.clearTimeout(saveTimeout.current);
    };
  }, []);

  if (!editor) return null;

  return (
    <div className="editor-page">
      <div className="editor-header">
        <div className="breadcrumb">{breadcrumb}</div>
        {editingTitle ? (
          <input
            className="title-input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
              if (e.key === 'Escape') { setTitle(page.title); setEditingTitle(false); }
            }}
          />
        ) : (
          <h1 className="title-display" onClick={() => setEditingTitle(true)} tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setEditingTitle(true); }}>
            {title}
          </h1>
        )}
      </div>

      <Toolbar editor={editor} />

      {findOpen && <FindBar editor={editor} onClose={() => setFindOpen(false)} showReplace={findReplaceMode} />}

      <div className="editor-scroll" ref={scrollRef} onClick={() => editor.chain().focus().run()}>
        <EditorContent editor={editor} className="editor-content" />
      </div>
    </div>
  );
}
