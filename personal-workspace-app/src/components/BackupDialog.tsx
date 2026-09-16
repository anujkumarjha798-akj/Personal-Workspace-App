import { useRef, useState } from 'react';
import { X, UploadCloud } from 'lucide-react';
import {
  exportAsJSON, exportAsZip, parseBackupFile, replaceWorkspace, mergeWorkspace, type ParsedBackup,
} from '../services/backup';

interface BackupDialogProps {
  onClose: () => void;
  hasExisting: boolean;
  onImported: () => void;
  initialTab?: 'export' | 'import';
}

export function BackupDialog({ onClose, hasExisting, onImported, initialTab = 'export' }: BackupDialogProps) {
  const [tab, setTab] = useState<'export' | 'import'>(initialTab);
  const [dragActive, setDragActive] = useState(false);
  const [pending, setPending] = useState<{ file: File; backup: ParsedBackup } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    try {
      const backup = await parseBackupFile(file);
      setPending({ file, backup });
    } catch {
      setError('Invalid backup file.');
    }
  };

  const doImport = async (mode: 'replace' | 'merge') => {
    if (!pending) return;
    setBusy(true);
    try {
      if (mode === 'replace') await replaceWorkspace(pending.backup);
      else await mergeWorkspace(pending.backup);
      onImported();
      onClose();
    } catch {
      setError('Backup could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-tabs">
            <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>Export</button>
            <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>Import</button>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        {tab === 'export' ? (
          <div className="modal-body">
            <p>Export your entire workspace — pages, folders, and images — as a restorable backup.</p>
            <div className="modal-actions">
              <button className="btn-primary" onClick={() => exportAsZip()}>ZIP Backup</button>
              <button className="btn-secondary" onClick={() => exportAsJSON()}>JSON</button>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            {!pending ? (
              <div
                className={`dropzone${dragActive ? ' active' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleFile(file);
                }}
                onClick={() => inputRef.current?.click()}
              >
                <UploadCloud size={28} />
                <p>Drop backup file here</p>
                <p className="dropzone-hint">.zip or .json</p>
                <input
                  ref={inputRef} type="file" accept=".zip,.json" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
              </div>
            ) : (
              <div className="backup-preview">
                <p>Backup detected ✓</p>
                <div className="backup-stats">
                  <div>Pages: {pending.backup.pageCount}</div>
                  <div>Folders: {pending.backup.folderCount}</div>
                </div>
                {hasExisting ? (
                  <>
                    <p className="warn-text">Existing workspace detected. How should this import be handled?</p>
                    <div className="modal-actions">
                      <button className="btn-primary" disabled={busy} onClick={() => doImport('replace')}>Replace Workspace</button>
                      <button className="btn-secondary" disabled={busy} onClick={() => doImport('merge')}>Merge Workspace</button>
                      <button className="btn-secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <div className="modal-actions">
                    <button className="btn-primary" disabled={busy} onClick={() => doImport('replace')}>Import</button>
                    <button className="btn-secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                  </div>
                )}
              </div>
            )}
            {error && <p className="error-text">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
