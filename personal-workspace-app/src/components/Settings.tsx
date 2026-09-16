import { X } from 'lucide-react';
import type { ThemeMode } from '../types';

interface SettingsProps {
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  reminderEnabled: boolean;
  onReminderChange: (v: boolean) => void;
  lastBackup: number | null;
  onClose: () => void;
  onOpenBackup: () => void;
}

export function Settings({ theme, onThemeChange, reminderEnabled, onReminderChange, lastBackup, onClose, onOpenBackup }: SettingsProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="settings-row">
            <span>Theme</span>
            <div className="segmented">
              {(['dark', 'light', 'system'] as ThemeMode[]).map((t) => (
                <button key={t} className={theme === t ? 'active' : ''} onClick={() => onThemeChange(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <span>Last backup</span>
            <span className="muted">{lastBackup ? new Date(lastBackup).toLocaleString() : 'Never'}</span>
          </div>

          <label className="settings-row checkbox-row">
            <span>Remind me to create backups</span>
            <input type="checkbox" checked={reminderEnabled} onChange={(e) => onReminderChange(e.target.checked)} />
          </label>

          <div className="modal-actions">
            <button className="btn-primary" onClick={onOpenBackup}>Export Backup</button>
          </div>
        </div>
      </div>
    </div>
  );
}
