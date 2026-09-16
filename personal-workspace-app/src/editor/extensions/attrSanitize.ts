// Attribute sanitizers for style-producing document attributes (color, font
// size, highlight). Document JSON can arrive from untrusted sources (the API
// is open to anyone with access to the server, and backups can be imported),
// so values are re-validated at render time. Anything that is not a plain CSS
// value is dropped instead of being interpolated into a style attribute.

export function safeColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 64) return false;
  return /^(#[0-9a-fA-F]{3,8}|rgb\(\s*[\d\s.,%]*\s*\)|rgba\(\s*[\d\s.,%]*\s*\)|hsl\(\s*[\d\s.,%]*\s*\)|hsla\(\s*[\d\s.,%]*\s*\)|[a-z]+)$/.test(v);
}

export function safeFontSizeValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 32) return false;
  return /^(\d{1,3}(\.\d+)?(px|pt|em|rem|%)?|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller)$/.test(v);
}