// Sanitizes HTML pulled from the clipboard (e.g. pasted from ChatGPT, Word,
// Google Docs, or a browser page) before it's handed to ProseMirror's schema
// parser. We deliberately do NOT hand-map tags to Tiptap nodes here — every
// extension we use (Heading, Bold, Italic, Underline, Strike, Lists, TaskList,
// Blockquote, CodeBlock, Code, HorizontalRule, Link, Table*) already declares
// its own `parseHTML` rules, so the schema-aware parser maps <h1>, <strong>,
// <u>, <s>, <ul>/<ol>/<li>, <blockquote>, <pre><code>, <code>, <hr>, <a>, and
// <table> correctly on its own. This function's only job is safety: strip
// scripts, dangerous elements, event handlers, and dangerous URLs, while
// leaving normal formatting markup untouched.

const DISALLOWED_TAGS = [
  'script', 'style', 'link', 'meta', 'iframe', 'object', 'embed',
  'form', 'input', 'button', 'select', 'textarea', 'svg', 'noscript', 'base',
  'audio', 'video', 'canvas', 'applet',
];

function isDangerousUrl(value: string): boolean {
  // Strip control characters (e.g. null bytes some browsers drop before
  // navigation) before testing the scheme.
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')) {
    return true;
  }
  if (v.startsWith('data:') && !v.startsWith('data:image/')) {
    return true;
  }
  if (v.startsWith('blob:') || v.startsWith('filesystem:')) {
    return true;
  }
  return false;
}

export function sanitizePastedHtml(html: string): string {
  if (!html || !html.trim()) return '';

  const doc = new window.DOMParser().parseFromString(html, 'text/html');

  DISALLOWED_TAGS.forEach((tag) => {
    doc.body.querySelectorAll(tag).forEach((el) => el.remove());
  });

  const walk = (node: Element) => {
    // Copy the attribute list before mutating it while iterating.
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        return;
      }
      if ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction') && isDangerousUrl(attr.value)) {
        node.removeAttribute(attr.name);
        return;
      }
      if (name === 'style' && /expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import|url\(\s*['"]?\s*(javascript|vbscript):/i.test(attr.value)) {
        node.removeAttribute(attr.name);
        return;
      }
      if (name === 'srcdoc' || name === 'formaction') {
        node.removeAttribute(attr.name);
      }
    });
    Array.from(node.children).forEach((child) => walk(child));
  };

  Array.from(doc.body.children).forEach((child) => walk(child));

  return doc.body.innerHTML;
}
