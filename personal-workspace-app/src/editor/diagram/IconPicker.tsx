// Searchable built-in icon library backed by `simple-icons` (offline npm
// package of brand vector paths — docker, aws, python, nginx, …). The library
// chunk is lazy-loaded the first time the panel opens; chosen icons are
// snapshot into the diagram data so notes never depend on this chunk again.
import { useEffect, useMemo, useRef, useState } from 'react';

export interface SimpleIcon {
  title: string;
  slug: string;
  hex: string;
  path: string;
}

interface IconEntry extends SimpleIcon {
  searchKey: string;
}

let libPromise: Promise<IconEntry[]> | null = null;

async function loadLibrary(): Promise<IconEntry[]> {
  const mod: any = await import('simple-icons');
  const out: IconEntry[] = [];
  for (const value of Object.values(mod)) {
    const icon = value as SimpleIcon;
    if (icon && typeof icon.title === 'string' && typeof icon.path === 'string' && icon.path) {
      out.push({ ...icon, searchKey: `${icon.title} ${icon.slug}`.toLowerCase() });
    }
  }
  return out;
}

async function getLibrary(): Promise<IconEntry[]> {
  if (!libPromise) libPromise = loadLibrary();
  return libPromise;
}

const SUGGESTED = ['docker', 'kubernetes', 'linux', 'ubuntu', 'git', 'github', 'python', 'javascript',
  'typescript', 'html5', 'css3', 'react', 'nodedotjs', 'nginx', 'mysql', 'postgresql', 'redis',
  'mongodb', 'aws', 'googlecloud', 'terraform', 'ansible', 'jenkins', 'php', 'java', 'apache'];

export function IconPicker({ open, onClose, onPick }: {
  open: boolean;
  onClose: () => void;
  onPick: (icon: SimpleIcon) => void;
}) {
  const [all, setAll] = useState<IconEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || all || failed) return;
    let alive = true;
    getLibrary()
      .then((lib) => { if (alive) setAll(lib); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open, all, failed]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const results = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    if (!q) {
      const suggested = SUGGESTED
        .map((slug) => all.find((i) => i.slug === slug))
        .filter((i): i is IconEntry => !!i);
      return suggested.length ? suggested : all.slice(0, 60);
    }
    return all.filter((i) => i.searchKey.includes(q)).slice(0, 96);
  }, [all, query]);

  if (!open) return null;

  return (
    <div className="dg-icon-panel" role="dialog" aria-label="Icon library">
      <div className="dg-icon-head">
        <input
          ref={inputRef}
          className="dg-icon-search"
          placeholder="Search icons… (docker, aws, python)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        />
        <button type="button" className="toolbar-btn" title="Close" onClick={onClose}>✕</button>
      </div>
      <div className="dg-icon-grid">
        {!all && !failed && <div className="dg-icon-status">Loading icon library…</div>}
        {failed && <div className="dg-icon-status">Icon library unavailable.</div>}
        {all && !results.length && <div className="dg-icon-status">No icons match “{query}”.</div>}
        {results.map((icon) => (
          <button
            key={icon.slug}
            type="button"
            className="dg-icon-cell"
            title={`${icon.title} (${icon.slug})`}
            onClick={() => onPick(icon)}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" role="img" aria-label={icon.title}>
              <path d={icon.path} fill={`#${icon.hex}`} />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
