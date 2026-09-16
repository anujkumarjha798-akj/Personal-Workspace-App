import Highlight from '@tiptap/extension-highlight';
import { safeColorValue } from './attrSanitize';

// Highlight with render-time validation of the color attribute (see SafeColor).
export const SafeHighlight = Highlight.extend({
  addAttributes() {
    if (!this.options.multicolor) {
      return {};
    }
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute('data-color') || element.style.backgroundColor || null;
          return safeColorValue(value) ? value : null;
        },
        renderHTML: (attributes) => {
          if (!safeColorValue(attributes.color)) return {};
          return {
            'data-color': attributes.color,
            style: `background-color: ${attributes.color}; color: inherit`,
          };
        },
      },
    };
  },
});