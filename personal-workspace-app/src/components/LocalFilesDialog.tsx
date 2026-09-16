import { useEffect, useState } from 'react';
import { X, Folder, FileText, ChevronLeft, Home, Loader } from 'lucide-react';
import { api, type LocalFileEntry, type LocalReadResult } from '../services/api';

function formatSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface LocalFilesDialogProps {
  onClose: () => void;
}

export function LocalFilesDialog({ onClose }: LocalFilesDialogProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [up, setUp] = useState<string | null>(null);
  const [entries, setEntries] = useState<LocalFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LocalReadResult | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const loadDir = async (dir?: string) => {
    setLoading(true);
    setError(null);
    setPreview(null);
    setPreviewPath(null);
    try {
      const res = await api.localList(dir);
      setRoot(res.root);
      setCur(res.path);
      setUp(res.up);
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list folder.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDir();
  }, []);

  const openFile = async (entry: LocalFileEntry) => {
    setError(null);
    setPreview(null);
    setPreviewPath(entry.path);
    try {
      const res = await api.localRead(entry.path);
      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read file.');
      setPreviewPath(null);
    }
  };

  const relativePath = root && cur ? cur.replace(root, '') || '/' : cur || '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Local files</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
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
              disabled={!root || loading}
              title="Workspace root"
              onClick={() => void loadDir(root ?? undefined)}
            >
              <Home size={14} /> Root
            </button>
            <span className="fb-path" title={cur ?? ''}>{relativePath}</span>
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="fb-list">
            {loading ? (
              <div className="fb-empty"><Loader size={14} /> Loading…</div>
            ) : entries.length === 0 ? (
              <div className="fb-empty">This folder is empty.</div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.path}
                  className={`fb-item${entry.isDir ? ' fb-dir' : ''}`}
                  onClick={() => {
                    if (entry.isDir) void loadDir(entry.path);
                    else void openFile(entry);
                  }}
                >
                  {entry.isDir ? <Folder size={15} className="fb-dir-icon" /> : <FileText size={15} className="fb-file-icon" />}
                  <span className="fb-name" title={entry.name}>{entry.name}</span>
                  <span className="fb-meta">
                    {entry.isDir ? '' : formatSize(entry.size)}
                  </span>
                </div>
              ))
            )}
          </div>

          {preview && previewPath && (
            <div className="fb-preview">
              <div className="fb-preview-head">
                <span className="muted" title={previewPath}>{preview.name}</span>
                <span className="muted">{formatSize(preview.size)}</span>
                <a className="btn-secondary fb-download" href={api.localFileUrl(previewPath)}>Download</a>
              </div>
              {preview.binary ? (
                <p className="fb-binary">
                  {preview.tooLarge
                    ? `Binary file larger than preview limit (${formatSize(preview.size)}). Use Download.`
                    : 'Binary file — use Download to open it on your machine.'}
                </p>
              ) : (
                <pre>{preview.content}</pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}