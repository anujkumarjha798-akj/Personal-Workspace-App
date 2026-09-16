import { useState } from 'react';
import { FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';

interface WelcomeProps {
  serverDown: boolean;
  busy: boolean;
  error: string | null;
  hasLastWorkspace: boolean;
  lastPath: string | null;
  tokenRequired: boolean;
  globalAccess?: boolean;
  localMode?: boolean;
  onRetry: () => void;
  onChooseFolder: () => void;
  onReopenLast: () => void;
  onNewWorkspace: () => void;
  onImportClick: () => void;
  onTokenSubmit: (token: string) => void;
}

export function Welcome({
  serverDown, busy, error, hasLastWorkspace, lastPath, tokenRequired, globalAccess = false, localMode = false,
  onRetry, onChooseFolder, onReopenLast, onNewWorkspace, onImportClick, onTokenSubmit,
}: WelcomeProps) {
  const [token, setToken] = useState('');

  if (serverDown) {
    return (
      <div className="welcome-screen">
        <div className="welcome-card">
          <div className="welcome-logo">personal://workspace</div>
          <h1>Local server not running</h1>
          <p className="welcome-sub">
            The workspace server could not be reached. Start the app with <code>npm run dev</code> and make sure nothing else is using its port.
          </p>
          <div className="welcome-actions">
            <button className="btn-primary" onClick={onRetry}><RefreshCw size={14} /> Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (tokenRequired) {
    return (
      <div className="welcome-screen">
        <div className="welcome-card">
          <div className="welcome-logo">personal://workspace</div>
          <h1>Access ID required</h1>
          <p className="welcome-sub">
            This device is not the machine running the workspace server. Enter your
            <strong> personal access code</strong> if the owner gave you one — or the
            Access ID shown in the server console for guest access.
          </p>
          <div className="token-form">
            <input
              className="token-input"
              type="text"
              autoFocus
              placeholder="Access ID"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && token.trim()) onTokenSubmit(token);
              }}
            />
            <button
              className="btn-primary"
              disabled={busy || !token.trim()}
              onClick={() => onTokenSubmit(token)}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <div className="welcome-logo">personal://workspace</div>
        {globalAccess ? (
          <>
            <h1>Personal Workspace</h1>
            <p className="welcome-sub">
              You are connected over the internet. For safety, no folder is opened
              automatically — the owner chooses a folder on their computer and it
              appears here for you.
            </p>
            <div className="welcome-actions">
              <button className="btn-primary" disabled={busy} onClick={onChooseFolder}>
                <FolderOpen size={14} /> {busy ? 'Waiting for owner…' : 'Ask Owner to Choose Folder…'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1>Personal Workspace</h1>
            <p className="welcome-sub">
              Pick a folder on this computer — it becomes your workspace. Everything is stored there and available from any browser.
            </p>
            {hasLastWorkspace && lastPath && (
              <p className="welcome-last">
                Last workspace:<br /><strong>{lastPath}</strong>
              </p>
            )}
            <div className="welcome-actions">
              {hasLastWorkspace ? (
                <>
                  <button className="btn-primary" disabled={busy} onClick={onReopenLast}>
                    {busy ? 'Opening…' : 'Open Last Workspace'}
                  </button>
                  <button className="btn-secondary" disabled={busy} onClick={onChooseFolder}>
                    <FolderOpen size={14} /> Choose Different Folder…
                  </button>
                </>
              ) : (
                <button className="btn-primary" disabled={busy} onClick={onChooseFolder}>
                  <FolderOpen size={14} /> {busy ? 'Choosing folder…' : 'Choose Workspace Folder…'}
                </button>
              )}
              {localMode && (
                <button className="btn-secondary" disabled={busy} onClick={onNewWorkspace}>
                  <FolderPlus size={14} /> New Workspace…
                </button>
              )}
              <button className="btn-secondary" disabled={busy} onClick={onImportClick}>Import Backup</button>
            </div>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}