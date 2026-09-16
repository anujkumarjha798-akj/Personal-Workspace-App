/**
 * Headless checks for the Format Painter transform logic.
 * Run with:
 *   npx tsx --import ./scripts/register-css-stub.mjs scripts/test-format-painter.ts
 *
 * Uses the real editor schema (from src/editor/extensions) plus plain
 * ProseMirror state, so no DOM is required.
 */
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { editorExtensions } from '../src/editor/extensions';
import { captureFormat, applyFormat } from '../src/editor/extensions/FormatPainter';

const schema = getSchema(editorExtensions as any);

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

function stateFromJSON(doc: any) {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(doc) });
}

function textOf(state: EditorState): string {
  return state.doc.textBetween(0, state.doc.content.size, '\n');
}

function select(state: EditorState, from: number, to: number) {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

// Source: a bold, blue, size-20, centered Heading 1 "Linux Commands".
// Target: a plain paragraph "Important Commands".
const doc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1, textAlign: 'center', indent: 2 },
      content: [
        {
          type: 'text',
          marks: [
            { type: 'bold' },
            { type: 'textStyle', attrs: { color: '#1e6bff', fontSize: '20px' } },
          ],
          text: 'Linux Commands',
        },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Important Commands' }] },
  ],
};

console.log('Format Painter — copy heading formatting onto a plain paragraph');
let state = stateFromJSON(doc);
const sourceEnd = 1 + 'Linux Commands'.length;
state = select(state, 1, sourceEnd);
const format = captureFormat(state);
check('captured marks include bold', !!format?.marks.some((m) => m.type === 'bold'));
check(
  'captured textStyle color + size',
  !!format?.marks.some((m) => m.type === 'textStyle' && m.attrs.color === '#1e6bff' && m.attrs.fontSize === '20px'),
);
check('captured block type heading', format?.blockType === 'heading');
check('captured heading level 1', format?.blockAttrs.level === 1);
check('captured textAlign center', format?.blockAttrs.textAlign === 'center');

const targetStart = sourceEnd + 2;
const targetEnd = targetStart + 'Important Commands'.length;
state = select(state, targetStart, targetEnd);
let tr = state.tr;
applyFormat(state, format!, tr);
state = state.apply(tr);

const painted = state.doc.child(1);
check('target text unchanged', painted.textContent === 'Important Commands', painted.textContent);
check('whole document text unchanged', textOf(state) === 'Linux Commands\nImportant Commands');
check('target became a heading', painted.type.name === 'heading', painted.type.name);
check('target heading level copied', painted.attrs.level === 1, painted.attrs.level);
check('target alignment copied', painted.attrs.textAlign === 'center', painted.attrs.textAlign);
check('target indent copied', painted.attrs.indent === 2, painted.attrs.indent);
const pMarks = painted.child(0).marks.map((m) => m.type.name);
check('target is bold', pMarks.includes('bold'), pMarks);
check(
  'target has copied color and size',
  painted.child(0).marks.some(
    (m) => m.type.name === 'textStyle' && m.attrs.color === '#1e6bff' && m.attrs.fontSize === '20px',
  ),
);
check('nothing was inserted or removed', state.doc.childCount === 2);

console.log('\nLinks, images and unrelated marks are preserved');
const doc2 = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'italic' }], text: 'Source' }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'bold' }],
          text: 'A link',
        },
      ],
    },
    { type: 'image', attrs: { src: 'attachments/pic.png' } },
  ],
};
let s2 = stateFromJSON(doc2);
s2 = select(s2, 1, 1 + 'Source'.length);
const fmt2 = captureFormat(s2)!;
const linkStart = 1 + 'Source'.length + 2;
s2 = select(s2, linkStart, linkStart + 'A link'.length);
const tr2 = s2.tr;
applyFormat(s2, fmt2, tr2);
s2 = s2.apply(tr2);
const linkPara = s2.doc.child(1);
check('link text unchanged', linkPara.textContent === 'A link');
check(
  'link mark preserved',
  linkPara.child(0).marks.some((m) => m.type.name === 'link' && m.attrs.href === 'https://example.com'),
);
check('italic copied to target', linkPara.child(0).marks.some((m) => m.type.name === 'italic'));
check('bold cleared (source had none)', !linkPara.child(0).marks.some((m) => m.type.name === 'bold'));
check('image node untouched', s2.doc.child(2).type.name === 'image' && s2.doc.child(2).attrs.src === 'attachments/pic.png');

console.log('\nOne paint = one undoable transaction');
check('single transaction used for the paint', tr2.steps.length > 0 && tr2.docChanged);

console.log('\nList items keep a valid structure (no heading inside a list item)');
const doc3 = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Head' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item one' }] }],
        },
      ],
    },
  ],
};
let s3 = stateFromJSON(doc3);
s3 = select(s3, 1, 1 + 'Head'.length);
const fmt3 = captureFormat(s3)!;
const itemStart = 1 + 'Head'.length + 1 + 3;
s3 = select(s3, itemStart, itemStart + 'Item one'.length);
const tr3 = s3.tr;
applyFormat(s3, fmt3, tr3);
s3 = s3.apply(tr3);
check('list item text unchanged', s3.doc.textBetween(0, s3.doc.content.size, '\n').includes('Item one'));
let stillValid = true;
try {
  s3.doc.check();
} catch {
  stillValid = false;
}
check('document still valid', stillValid);
check('bullet list still present', s3.doc.child(1).type.name === 'bulletList');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
