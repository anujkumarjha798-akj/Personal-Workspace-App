import { useCallback, useRef, type ChangeEvent } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code, Highlighter,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, List, ListOrdered, ListTodo,
  Table as TableIcon, ImageIcon, Link as LinkIcon, Minus, Undo2, Redo2, Palette,
  Indent as IndentIcon, Outdent, Eraser, Type, PencilRuler, Paperclip, Paintbrush,
} from 'lucide-react';
import { insertAttachments } from './attachments';
import { getFormatPainterState } from './extensions/FormatPainter';

function ToolbarButton({
  onClick, active, disabled, title, children,
}: { onClick: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={`toolbar-btn${active ? ' active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={!!active}
      aria-label={title}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="toolbar-divider" aria-hidden="true" />;
}

export function Toolbar({ editor }: { editor: Editor | null }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const painterArmedAt = useRef(0);

  const addImage = useCallback((file: File) => {
    if (!editor) return;
    const reader = new FileReader();
    reader.onload = () => {
      editor.chain().focus().setImage({ src: reader.result as string }).run();
    };
    reader.readAsDataURL(file);
  }, [editor]);

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) addImage(file);
    e.target.value = '';
  };

  const onAttachChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) void insertAttachments(editor!, files);
  };

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const painter = editor ? getFormatPainterState(editor.state) : null;

  // Single click arms the painter for one paint; a second click within a short
  // window (i.e. a double-click) keeps it armed for multiple targets. Clicking
  // again later simply turns it off.
  const toggleFormatPainter = () => {
    if (!editor) return;
    const state = getFormatPainterState(editor.state);
    if (state.active) {
      if (!state.sticky && Date.now() - painterArmedAt.current < 400) {
        editor.commands.setFormatPainterSticky(true);
        painterArmedAt.current = 0;
        return;
      }
      editor.commands.stopFormatPainter();
      return;
    }
    painterArmedAt.current = Date.now();
    editor.chain().focus().copyFormat().run();
  };

  if (!editor) return null;

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting toolbar">
      <select
        className="toolbar-select"
        title="Text style"
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v === 'p') chain.setParagraph().run();
          else chain.toggleHeading({ level: Number(v) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
        }}
        value={
          editor.isActive('heading', { level: 1 }) ? '1' :
          editor.isActive('heading', { level: 2 }) ? '2' :
          editor.isActive('heading', { level: 3 }) ? '3' :
          editor.isActive('heading', { level: 4 }) ? '4' :
          editor.isActive('heading', { level: 5 }) ? '5' :
          editor.isActive('heading', { level: 6 }) ? '6' : 'p'
        }
      >
        <option value="p">Paragraph</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
        <option value="4">Heading 4</option>
        <option value="5">Heading 5</option>
        <option value="6">Heading 6</option>
      </select>

      <Divider />

      <ToolbarButton title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolbarButton>
      <ToolbarButton title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolbarButton>
      <ToolbarButton title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolbarButton>
      <ToolbarButton title="Overline (Ctrl+Shift+O)" active={editor.isActive('overline')} onClick={() => editor.chain().focus().toggleOverline().run()}><Type size={16} /></ToolbarButton>
      <ToolbarButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={16} /></ToolbarButton>
      <ToolbarButton title="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight({ color: '#2e2e2e' }).run()}><Highlighter size={16} /></ToolbarButton>

      <label className="toolbar-color" title="Text color">
        <Palette size={16} />
        <input
          type="color"
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
          defaultValue="#e6e6e6"
        />
      </label>

      <select
        className="toolbar-select toolbar-select-narrow"
        title="Font size"
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) editor.chain().focus().setFontSize(e.target.value).run();
          else editor.chain().focus().unsetFontSize().run();
        }}
      >
        <option value="">Size</option>
        <option value="12px">12</option>
        <option value="14px">14</option>
        <option value="16px">16</option>
        <option value="18px">18</option>
        <option value="24px">24</option>
        <option value="32px">32</option>
      </select>

      <ToolbarButton
        title={
          painter?.active
            ? `Format Painter — Active${painter.sticky ? ' (locked: click the button to stop)' : ''} — select the text to format`
            : 'Format Painter — copy formatting from the selection (double-click to keep active)'
        }
        active={!!painter?.active}
        onClick={toggleFormatPainter}
      >
        <Paintbrush size={16} />
      </ToolbarButton>

      <ToolbarButton title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><Eraser size={16} /></ToolbarButton>

      <Divider />

      <ToolbarButton title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft size={16} /></ToolbarButton>
      <ToolbarButton title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter size={16} /></ToolbarButton>
      <ToolbarButton title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight size={16} /></ToolbarButton>
      <ToolbarButton title="Justify" active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}><AlignJustify size={16} /></ToolbarButton>

      <Divider />

      <ToolbarButton title="Bullet list (Ctrl+Shift+8)" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={16} /></ToolbarButton>
      <ToolbarButton title="Numbered list (Ctrl+Shift+7)" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolbarButton>
      <ToolbarButton title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListTodo size={16} /></ToolbarButton>
      <ToolbarButton title="Indent (Tab)" onClick={() => editor.chain().focus().indentBlock().run()}><IndentIcon size={16} /></ToolbarButton>
      <ToolbarButton title="Outdent (Shift+Tab)" onClick={() => editor.chain().focus().outdentBlock().run()}><Outdent size={16} /></ToolbarButton>

      <Divider />

      <ToolbarButton title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'</>'}</ToolbarButton>
      <ToolbarButton
        title="Insert table"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <TableIcon size={16} />
      </ToolbarButton>
      <ToolbarButton title="Insert link" active={editor.isActive('link')} onClick={setLink}><LinkIcon size={16} /></ToolbarButton>
      <ToolbarButton title="Insert image" onClick={() => fileInputRef.current?.click()}><ImageIcon size={16} /></ToolbarButton>
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange} />
      <ToolbarButton title="Attach file (documents, code, text, ZIP)" onClick={() => attachInputRef.current?.click()}><Paperclip size={16} /></ToolbarButton>
      <input ref={attachInputRef} type="file" multiple hidden onChange={onAttachChange} />
      <ToolbarButton title="Insert diagram (whiteboard)" onClick={() => editor.chain().focus().insertDiagram().run()}><PencilRuler size={16} /></ToolbarButton>
      <ToolbarButton title="Horizontal divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolbarButton>

      <Divider />

      <ToolbarButton title="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}><Undo2 size={16} /></ToolbarButton>
      <ToolbarButton title="Redo (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}><Redo2 size={16} /></ToolbarButton>

      {editor.isActive('table') && (
        <>
          <Divider />
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addRowAfter().run()}>+Row</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteRow().run()}>-Row</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().addColumnAfter().run()}>+Col</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteColumn().run()}>-Col</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().mergeCells().run()}>Merge</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().splitCell().run()}>Split</button>
          <button className="toolbar-btn text-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().deleteTable().run()}>Del table</button>
        </>
      )}
    </div>
  );
}
