import { Node, mergeAttributes } from '@tiptap/core';
import { api } from '../../services/api';

// A lightweight atomic block that renders an attached document/code/archive as
// a chip linking to the stored workspace attachment. Persistence rides entirely
// on the page content JSON (attrs -> workspace.json -> backups), same as images.
export const FileAttachment = Node.create({
  name: 'fileAttachment',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-name') || '',
        renderHTML: (attributes) => ({ 'data-name': attributes.name || '' }),
      },
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-title') || '',
        renderHTML: (attributes) => ({ 'data-title': attributes.title || '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-name]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = String(node.attrs.name || '');
    const title = String(node.attrs.title || name);
    if (!name) {
      return ['div', mergeAttributes({ class: 'file-attachment file-attachment-missing' }, HTMLAttributes), `${title}`];
    }
    const href = name.startsWith('data:') ? name : api.attachmentUrl(name);
    return [
      'div',
      mergeAttributes({ class: 'file-attachment' }, HTMLAttributes),
      ['a', { href, target: '_blank', rel: 'noopener noreferrer', download: name }, `${title}`],
    ];
  },
});