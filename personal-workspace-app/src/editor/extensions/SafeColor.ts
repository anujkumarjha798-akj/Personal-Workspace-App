import Color from '@tiptap/extension-color';
import { safeColorValue } from './attrSanitize';

// Color with render-time validation: document JSON (which can come from
// untrusted backups or the open API) is never interpolated into a style
// attribute without passing the value whitelist.
export const SafeColor = Color.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.style.color?.replace(/['"]+/g, '') || null;
          return safeColorValue(value) ? value : null;
        },
        renderHTML: (attributes: { color?: string | null }) => {
          if (!safeColorValue(attributes.color)) return {};
          return { style: `color: ${attributes.color}` };
        },
      },
    };
  },
});