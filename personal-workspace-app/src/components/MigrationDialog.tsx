import { DatabaseBackup } from 'lucide-react';

interface MigrationDialogProps {
  pages: number;
  folders: number;
  onImport: () => void;
  onSkip: () => void;
}

export function MigrationDialog({ pages, folders, onImport, onSkip }: MigrationDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Import existing browser data?</span>
        </div>
        <div className="modal-body">
          <p>
            <DatabaseBackup size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            We found data from the previous version of the app in this browser
            ({pages} pages, {folders} folders). Copy it into this new workspace?
          </p>
          <p className="warn-text">Your old browser data will not be deleted.</p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onImport}>Import into Workspace</button>
            <button className="btn-secondary" onClick={onSkip}>Skip</button>
          </div>
        </div>
      </div>
    </div>
  );
}