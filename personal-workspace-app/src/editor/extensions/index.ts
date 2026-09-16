import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { WorkspaceImage } from './WorkspaceImage';
import { SafeColor } from './SafeColor';
import { SafeHighlight } from './SafeHighlight';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import { Overline } from './Overline';
import { FontSize } from './FontSize';
import { Indent } from './Indent';
import { FindReplace } from './FindReplace';
import { FormatPainter } from './FormatPainter';
import { CodeBlockWithCopy } from './CodeBlockWithCopy';
import { DiagramBlock } from './DiagramBlock';
import { FileAttachment } from './FileAttachment';

export const editorExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // Replaced by CodeBlockWithCopy below (adds the copy-to-clipboard button).
    codeBlock: false,
    // Tiptap v3's StarterKit now bundles Link and Underline itself; we
    // configure our own instances below with custom options, so disable
    // the built-in ones to avoid duplicate-extension warnings/conflicts.
    link: false,
    underline: false,
  }),
  CodeBlockWithCopy.configure({
    HTMLAttributes: { class: 'code-block' },
  }),
  Underline,
  TextStyle,
  SafeColor,
  FontSize,
  SafeHighlight.configure({ multicolor: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  WorkspaceImage.configure({ inline: false, allowBase64: true }),
  Link.configure({ openOnClick: false, autolink: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Overline,
  Indent,
  FindReplace,
  FormatPainter,
  DiagramBlock,
  FileAttachment,
  Placeholder.configure({ placeholder: 'Start writing…' }),
  CharacterCount,
];
