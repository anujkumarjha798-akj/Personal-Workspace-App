import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { toImageUrl } from '../../services/api';

export const WorkspaceImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const merged = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    merged.src = toImageUrl(merged.src);
    return ['img', merged];
  },
});