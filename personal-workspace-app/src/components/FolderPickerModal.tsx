import { useEffect, useState } from 'react';
import { X, Folder, ChevronLeft, Home, Loader, HardDrive } from 'lucide-react';
import { api, type LocalDirEntry } from '../services/api';

interface FolderPickerModalProps {
  // 'open' picks an existing folder directly. 'new' picks a *parent* folder
  // and asks for a name, then creates the workspace folder inside it.
  mode: 'open' | 'new';
  title: string;
  busy?: boolean;
  onCancel: () => void;
  onSelect: (path: string) => void;
  onCreate?: (parentPath: string, name: string) => void;
}

export function FolderPickerModal({ mode, title, busy, onCancel, onSelect, onCreate }: FolderPickerModalProps) {
  const [cur, setCur] = useState<string | null>(null);
  const [up, setUp] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[] | null>(null);
  const [entries, setEntries] = useState<LocalDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [name, setName] = useState('My Workspace');

  const loadDir = async (dir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.localBrowse(dir);
      setCur(res.path);
      setUp(res.up);
      setHome(res.home);
      setDrives(res.drives);
      setEntries(res.entries);
      setPathInput(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list folder.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToTypedPath = () => {
    const target = pathInput.trim();
    if (target) void loadDir(target);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" onClick={onCancel}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="fb-toolbar">
            <button
              className="btn-secondary"
              disabled={!up || loading}
              title="Go up one level"
              onClick={() => { if (up) void loadDir(up); }}
            >
              <ChevronLeft size={14} /> Up
            </button>
            <button
              className="btn-secondary"
              disabled={!home || loading}
              title="Home folder"
              onClick={() => { if (home) void loadDir(home); }}
            >
              <Home size={14} /> Home
            </button>
          </div>

          <div className="fb-toolbar">
            <input
              className="fp-path-input"
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') goToTypedPath(); }}
              placeholder="Type or paste a folder path…"
            />
            <button className="btn-secondary" disabled={loading || !pathInput.trim()} onClick={goToTypedPath}>Go</button>
          </div>

          {drives && drives.length > 0 && (
            <div className="fp-drives">
              {drives.map((d) => (
                <button key={d} className="fp-drive-chip" disabled={loading} onClick={() => void loadDir(d)}>
                  <HardDrive size={12} /> {d}
                </button>
              ))}
            </div>
          )}

          {error && <p className="error-text">{error}</p>}

          <div className="fb-list">
            {loading ? (
              <div className="fb-empty"><Loader size={14} /> Loading…</div>
            ) : entries.length === 0 ? (
              <div className="fb-empty">No subfolders here.</div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.path}
                  className="fb-item fb-dir"
                  onClick={() => void loadDir(entry.path)}
                >
                  <Folder size={15} className="fb-dir-icon" />
                  <span className="fb-name" title={entry.name}>{entry.name}</span>
                </div>
              ))
            )}
          </div>

          {mode === 'new' && (
            <div className="fp-name-row">
              <label className="fp-name-label" htmlFor="fp-workspace-name">New workspace folder name</label>
              <input
                id="fp-workspace-name"
                className="fp-path-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Workspace"
              />
            </div>
          )}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onCancel}>Cancel</button>
            {mode === 'open' ? (
              <button
                className="btn-primary"
                disabled={!cur || loading || !!busy}
                onClick={() => cur && onSelect(cur)}
              >
                {busy ? 'Opening…' : 'Select This Folder'}
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={!cur || loading || !!busy || !name.trim()}
                onClick={() => cur && onCreate?.(cur, name.trim())}
              >
                {busy ? 'Creating…' : 'Create Workspace Here'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
