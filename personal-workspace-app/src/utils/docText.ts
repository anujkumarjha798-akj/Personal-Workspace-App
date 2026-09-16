export function docToText(contentJson: string): string {
  try {
    const doc = JSON.parse(contentJson);
    let text = '';
    const walk = (node: any) => {
      if (!node) return;
      if (node.text) text += node.text + ' ';
      (node.content || []).forEach(walk);
    };
    walk(doc);
    return text;
  } catch {
    return '';
  }
}

export function excerptAround(text: string, query: string, radius = 40): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
