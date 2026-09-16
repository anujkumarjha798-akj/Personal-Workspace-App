import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspace, useWorkspace } from './store/workspace';
import { api, applyTokenFromUrl, setServerToken, TokenRequiredError, type OpenWorkspaceResult } from './services/api';
import { hasLegacyData, importLegacyIntoWorkspace, type LegacyCounts } from './services/migrate';
import {
  createPage, updatePage, softDeletePage, restorePage, permanentlyDeletePage,
  duplicatePage, toggleFavorite, movePage,
} from './db/pages';
import { createFolder, renameFolder, deleteFolder } from './db/folders';
import type { SaveStatus, ThemeMode, OutlineHeading } from './types';
import { PanelLeft, PanelRight } from 'lucide-react';
import { Sidebar, type SidebarView } from './components/Sidebar';
import { RightPanel } from './components/RightPanel';
import { DocEditor } from './editor/Editor';
import { Welcome } from './components/Welcome';
import { BackupDialog } from './components/BackupDialog';
import { Settings } from './components/Settings';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MigrationDialog } from './components/MigrationDialog';
import { FolderPickerModal } from './components/FolderPickerModal';

type AppScreen = 'loading' | 'welcome' | 'workspace';

export default function App() {
  const pages = useWorkspace((s) => s.pages);
  const folders = useWorkspace((s) => s.folders);
  const saveError = useWorkspace((s) => s.saveError);

  const [screen, setScreen] = useState<AppScreen>('loading');
  const [serverDown, setServerDown] = useState(false);
  const [tokenRequired, setTokenRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasLastWorkspace, setHasLastWorkspace] = useState(false);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [viaTunnel, setViaTunnel] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  // Errors from "Open Folder…" / "New Workspace…" when triggered from the
  // sidebar (i.e. a workspace is already open, so the Welcome screen and its
  // `welcomeError` banner aren't on screen) previously vanished silently —
  // the user would click the button, the native dialog would fail or be
  // cancelled, and nothing visible happened. Surface those errors here too.
  const [localActionError, setLocalActionError] = useState<string | null>(null);
  const [migration, setMigration] = useState<LegacyCounts | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [view, setView] = useState<SidebarView>('all');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [outline, setOutline] = useState<OutlineHeading[]>([]);
  const [activeHeadingPos, setActiveHeadingPos] = useState<number | null>(null);
  // The Editor hands us a navigate(pos) function whenever its instance
  // (re)mounts; kept in a ref (not state) since it's a live callback the
  // Outline panel invokes directly, not something the render needs to react to.
  const outlineNavigateRef = useRef<(pos: number) => void>(() => {});
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  const [backupDialog, setBackupDialog] = useState<'export' | 'import' | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmFolderDelete, setConfirmFolderDelete] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  // Open Folder / New Workspace now use an in-page picker (browses the local
  // filesystem via the server) instead of a native OS dialog, so it can never
  // open behind the browser window. null = closed.
  const [folderPicker, setFolderPicker] = useState<'open' | 'new' | null>(null);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);

  // ---- phone / tablet layout -------------------------------------------------
  // Below 900px the side panels become slide-in drawers driven by the top
  // bar buttons; the desktop collapse toggles stop applying.
  const [isNarrow, setIsNarrow] = useState(
    () => window.matchMedia('(max-width: 900px)').matches,
  );
  const [mobilePanel, setMobilePanel] = useState<'none' | 'sidebar' | 'right'>('none');
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const closeMobilePanel = useCallback(() => setMobilePanel('none'), []);

  const selectedPage = useMemo(() => pages.find((p) => p.id === selectedPageId) ?? null, [pages, selectedPageId]);

  // Outline positions are only meaningful for the page that produced them —
  // clear the highlight immediately on page switch so it can't briefly point
  // at an unrelated heading in the newly opened document.
  useEffect(() => {
    setActiveHeadingPos(null);
  }, [selectedPageId]);

  const applySettingsFromStore = useCallback(() => {
    const savedTheme = workspace.getSetting('theme');
    const savedReminder = workspace.getSetting('reminderEnabled');
    const savedLastBackup = workspace.getSetting('lastBackup');
    if (savedTheme) setTheme(savedTheme as ThemeMode);
    if (savedReminder) setReminderEnabled(savedReminder === 'true');
    if (savedLastBackup) setLastBackup(Number(savedLastBackup));
  }, []);

  const boot = useCallback(async () => {
    setWelcomeError(null);
    applyTokenFromUrl();
    try {
      await api.health();
      const status = await api.workspaceStatus();
      setHasLastWorkspace(!!status.lastPath);
      setLastPath(status.lastPath);
      setViaTunnel(!!status.viaTunnel);
      setLocalMode(!!status.isLocal);
      setServerDown(false);
      setTokenRequired(false);
    } catch (err) {
      if (err instanceof TokenRequiredError) {
        setTokenRequired(true);
        setServerDown(false);
      } else {
        setServerDown(true);
      }
    }
    setScreen('welcome');
  }, []);

  const handleTokenSubmit = useCallback(async (token: string) => {
    setBusy(true);
    setWelcomeError(null);
    let value = token.trim();
    try {
      const u = new URL(value);
      value = u.searchParams.get('token') || value;
    } catch {
      // not a URL — use the raw value
    }
    setServerToken(value);
    try {
      await api.health();
      const status = await api.workspaceStatus();
      setHasLastWorkspace(!!status.lastPath);
      setLastPath(status.lastPath);
      setViaTunnel(!!status.viaTunnel);
      setLocalMode(!!status.isLocal);
      setTokenRequired(false);
    } catch (err) {
      if (err instanceof TokenRequiredError) {
        setWelcomeError('Invalid Access ID.');
      } else {
        setServerDown(true);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
  }, [theme]);

  // Every code path that opens, creates, or reopens a workspace funnels its
  // result through here. This used to only update the screen/path — it never
  // pushed `result.state` into the `workspace` store. `workspace.openViaPicker()`
  // and `workspace.reopenLast()` happen to call `applyState` themselves before
  // returning, which masked the bug for the tunnel and auto-reopen-on-boot
  // paths, but the primary local "Open Folder…" / "New Workspace…" flows
  // (`handleFolderPickerSelect` / `handleFolderPickerCreate`) call the API
  // directly and relied on this function alone — so the UI kept rendering the
  // *previous* workspace's folders/pages, and any edit made afterward was
  // saved into the newly opened workspace's file with the old data still in
  // it. Applying state here unconditionally closes that gap for every caller,
  // present and future, and is a no-op (idempotent) for callers that already
  // applied it themselves.
  const finishOpen = useCallback(async (result: OpenWorkspaceResult) => {
    if (result.cancelled || !result.path) return;
    if (result.state) {
      workspace.applyState(result.state, result.path);
    } else {
      // Defensive: an open/create response without state should never
      // happen, but if it ever does, never let stale workspace data linger.
      workspace.clearState();
    }
    setHasLastWorkspace(true);
    setLastPath(result.path);
    setScreen('workspace');
    setSelectedPageId(null);
    applySettingsFromStore();
    if (result.isNew) {
      const counts = await hasLegacyData();
      if (counts.pages > 0 || counts.folders > 0) setMigration(counts);
    }
  }, [applySettingsFromStore]);

  // On a tunnel/global-access session there is no local browser to show the
  // in-page picker to — the owner picks on their own PC, so this keeps using
  // the server-side native dialog (see /api/workspace/open).
  const handleChooseFolder = useCallback(async () => {
    if (viaTunnel) {
      setBusy(true);
      setWelcomeError(null);
      try {
        await finishOpen(await workspace.openViaPicker());
      } catch (err) {
        setWelcomeError(err instanceof Error ? err.message : 'Could not open workspace.');
      } finally {
        setBusy(false);
      }
      return;
    }
    setWelcomeError(null);
    setLocalActionError(null);
    setFolderPicker('open');
  }, [finishOpen, viaTunnel]);

  const handleReopenLast = useCallback(async () => {
    setBusy(true);
    setWelcomeError(null);
    try {
      await finishOpen(await workspace.reopenLast());
    } catch (err) {
      setWelcomeError(err instanceof Error ? err.message : 'Could not open workspace.');
    } finally {
      setBusy(false);
    }
  }, [finishOpen]);

  const handleLocalOpen = useCallback(() => {
    setWelcomeError(null);
    setLocalActionError(null);
    setFolderPicker('open');
  }, []);

  const handleLocalNew = useCallback(() => {
    setWelcomeError(null);
    setLocalActionError(null);
    setFolderPicker('new');
  }, []);

  const handleFolderPickerSelect = useCallback(async (path: string) => {
    setFolderPickerBusy(true);
    try {
      // Persist any pending debounced edit to the workspace we're about to
      // leave BEFORE switching. Without this, a save timer could still fire
      // after `openPath` moves to the new folder and write the old
      // workspace's data into the new workspace's file. Mirrors
      // workspace.openViaPicker() / reopenLast(), which already do this.
      await workspace.flush().catch(() => {});
      const result = await api.localOpen(path);
      await finishOpen(result);
      if (!result.cancelled) setFolderPicker(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open folder.';
      setWelcomeError(message);
      setLocalActionError(message);
    } finally {
      setFolderPickerBusy(false);
    }
  }, [finishOpen]);

  const handleFolderPickerCreate = useCallback(async (parentPath: string, name: string) => {
    setFolderPickerBusy(true);
    try {
      // Same reasoning as handleFolderPickerSelect: flush the outgoing
      // workspace's pending edits before creating/switching to the new one.
      await workspace.flush().catch(() => {});
      const result = await api.localCreate(parentPath, name);
      await finishOpen(result);
      if (!result.cancelled) setFolderPicker(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create workspace.';
      setWelcomeError(message);
      setLocalActionError(message);
    } finally {
      setFolderPickerBusy(false);
    }
  }, [finishOpen]);

  // ---- automatic workspace open ---------------------------------------------
  // Owner / LAN visitors: the remembered local workspace opens silently —
  // nobody should pick a folder on every visit. GLOBAL (tunnel) visitors are
  // deliberately excluded: the owner must grant them a folder explicitly each
  // session, so the chooser pops up on the owner's PC.
  const autoOpenTried = useRef(false);
  useEffect(() => {
    if (autoOpenTried.current) return;
    if (screen !== 'welcome' || tokenRequired || serverDown || viaTunnel || !lastPath) return;
    autoOpenTried.current = true;
    setBusy(true);
    (async () => {
      try {
        const result = await workspace.reopenLast();
        if (result.cancelled || !result.path) {
          setWelcomeError('The saved workspace could not be opened — choose a folder below.');
          return;
        }
        await finishOpen(result);
      } catch (err) {
        setWelcomeError(
          err instanceof Error
            ? `${err.message} — choose a folder below.`
            : 'Could not reopen the saved workspace — choose a folder below.',
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [screen, tokenRequired, serverDown, viaTunnel, lastPath, finishOpen]);

  const handleImportClick = useCallback(async () => {
    if (workspace.path) {
      setScreen('workspace');
      setBackupDialog('import');
      return;
    }
    setBusy(true);
    setWelcomeError(null);
    try {
      // Tunnel visitors never silently reopen the last folder — straight to
      // the chooser so the owner grants access explicitly.
      let result = viaTunnel
        ? { cancelled: true } as OpenWorkspaceResult
        : await workspace.reopenLast();
      if (result.cancelled || !result.path) result = await workspace.openViaPicker();
      if (result.cancelled || !result.path) return;
      await finishOpen(result);
      setBackupDialog('import');
    } catch (err) {
      setWelcomeError(err instanceof Error ? err.message : 'Could not open workspace.');
    } finally {
      setBusy(false);
    }
  }, [finishOpen, viaTunnel]);

  const persistSetting = useCallback((key: string, value: string) => {
    workspace.putSetting(key, value);
  }, []);

  const breadcrumb = useMemo(() => {
    if (!selectedPage) return '';
    const chain: string[] = [];
    let folderId = selectedPage.folderId;
    while (folderId) {
      const f = folders.find((x) => x.id === folderId);
      if (!f) break;
      chain.unshift(f.name);
      folderId = f.parentId;
    }
    chain.push(selectedPage.title);
    return chain.join(' / ');
  }, [selectedPage, folders]);

  const handleNewPage = useCallback(async (folderId: string | null) => {
    const page = await createPage(folderId);
    setSelectedPageId(page.id);
    setView('all');
  }, []);

  const handleNewFolder = useCallback(async (parentId: string | null) => {
    await createFolder(parentId);
  }, []);

  const handleImported = useCallback(() => {
    setSelectedPageId(null);
    setScreen('workspace');
  }, []);

  const handleMigrationImport = useCallback(async () => {
    try {
      await importLegacyIntoWorkspace();
      applySettingsFromStore();
    } catch {
      setWelcomeError('Browser data could not be imported. The workspace was still opened.');
    }
    setMigration(null);
  }, [applySettingsFromStore]);

  const handleMigrationSkip = useCallback(() => {
    setMigration(null);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (screen === 'workspace') handleNewPage(null);
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        if (screen === 'workspace') setBackupDialog('import');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [screen, handleNewPage]);

  if (screen === 'loading') {
    return <div className="app-loading">Loading workspace…</div>;
  }

  if (screen === 'welcome') {
    return (
      <Welcome
        serverDown={serverDown}
        busy={busy}
        error={welcomeError}
        hasLastWorkspace={hasLastWorkspace}
        lastPath={lastPath}
        tokenRequired={tokenRequired}
        globalAccess={viaTunnel}
        localMode={localMode}
        onRetry={boot}
        onChooseFolder={handleChooseFolder}
        onReopenLast={handleReopenLast}
        onNewWorkspace={handleLocalNew}
        onImportClick={handleImportClick}
        onTokenSubmit={handleTokenSubmit}
      />
    );
  }

  const statusLabel: Record<SaveStatus, string> = {
    idle: '', editing: 'Editing', saving: 'Saving…', saved: 'Saved ✓', error: 'Save failed',
  };

  return (
    <div className={`app-shell${mobilePanel === 'sidebar' ? ' panel-sidebar-open' : ''}${mobilePanel === 'right' ? ' panel-right-open' : ''}`}>
      <Sidebar
        folders={folders}
        pages={pages}
        selectedPageId={selectedPageId}
        view={view}
        collapsed={leftCollapsed && !isNarrow}
        onToggleCollapsed={() => setLeftCollapsed((v) => !v)}
        onSelectPage={(id) => { setSelectedPageId(id); closeMobilePanel(); }}
        onSetView={setView}
        onNewPage={(fid) => { handleNewPage(fid); closeMobilePanel(); }}
        onNewFolder={handleNewFolder}
        onRenamePage={(id, title) => updatePage(id, { title })}
        onDuplicatePage={async (id) => { const p = await duplicatePage(id); if (p) setSelectedPageId(p.id); }}
        onSoftDeletePage={(id) => { softDeletePage(id); if (id === selectedPageId) setSelectedPageId(null); }}
        onRestorePage={restorePage}
        onPermanentDeletePage={(id) => setConfirmPurge(id)}
        onToggleFavorite={toggleFavorite}
        onMovePage={movePage}
        onRenameFolder={renameFolder}
        onDeleteFolder={(id) => setConfirmFolderDelete(id)}
        onOpenSettings={() => { setShowSettings(true); closeMobilePanel(); }}
        localMode={localMode}
        onOpenFolder={handleLocalOpen}
        onNewWorkspace={handleLocalNew}
      />

      <main className="main-area">
        <div className="mobile-topbar">
          <button
            className="icon-btn mobile-topbar-btn"
            title="Pages"
            aria-label="Open pages sidebar"
            onClick={() => setMobilePanel((p) => (p === 'sidebar' ? 'none' : 'sidebar'))}
          >
            <PanelLeft size={19} />
          </button>
          <span className="mobile-topbar-title">{selectedPage ? selectedPage.title : 'Workspace'}</span>
          <button
            className="icon-btn mobile-topbar-btn"
            title="Details"
            aria-label="Open details panel"
            onClick={() => setMobilePanel((p) => (p === 'right' ? 'none' : 'right'))}
          >
            <PanelRight size={19} />
          </button>
        </div>
        {localActionError && (
          <div className="save-error-banner" onClick={() => setLocalActionError(null)} title="Click to dismiss">
            {localActionError}
          </div>
        )}
        {saveError && (
          <div className="save-error-banner" onClick={() => workspace.clearSaveError()} title="Click to dismiss">
            Save failed: {saveError}
          </div>
        )}
        {selectedPage ? (
          <>
            <div className="status-bar">
              <span className={`save-status status-${saveStatus}`}>{statusLabel[saveStatus]}</span>
            </div>
            <DocEditor
              key={selectedPage.id}
              page={selectedPage}
              breadcrumb={breadcrumb}
              onStatusChange={setSaveStatus}
              onOutlineChange={setOutline}
              onStatsChange={setStats}
              onTitleChange={() => {}}
              onNavigatorReady={(fn) => { outlineNavigateRef.current = fn; }}
              onActiveHeadingChange={setActiveHeadingPos}
            />
          </>
        ) : (
          <div className="empty-state">
            <p>Select a page from the sidebar, or create a new one to start writing.</p>
            <button className="btn-primary" onClick={() => handleNewPage(null)}>+ New Page</button>
          </div>
        )}
      </main>

      <RightPanel
        page={selectedPage}
        collapsed={rightCollapsed && !isNarrow}
        onToggleCollapsed={() => setRightCollapsed((v) => !v)}
        outline={outline}
        activeHeadingPos={activeHeadingPos}
        onOutlineNavigate={(pos) => outlineNavigateRef.current(pos)}
        stats={stats}
      />

      {mobilePanel !== 'none' && (
        <div className="drawer-backdrop" onClick={closeMobilePanel} />
      )}


      {backupDialog && (
        <BackupDialog
          initialTab={backupDialog}
          hasExisting={pages.length > 0 || folders.length > 0}
          onClose={() => setBackupDialog(null)}
          onImported={handleImported}
        />
      )}

      {showSettings && (
        <Settings
          theme={theme}
          onThemeChange={(t) => { setTheme(t); persistSetting('theme', t); }}
          reminderEnabled={reminderEnabled}
          onReminderChange={(v) => { setReminderEnabled(v); persistSetting('reminderEnabled', String(v)); }}
          lastBackup={lastBackup}
          onClose={() => setShowSettings(false)}
          onOpenBackup={() => { setShowSettings(false); setBackupDialog('export'); }}
        />
      )}

      {confirmFolderDelete && (
        <ConfirmDialog
          title="Delete folder?"
          message="Pages inside will be moved to Trash and subfolders moved up a level."
          confirmLabel="Delete Folder"
          danger
          onCancel={() => setConfirmFolderDelete(null)}
          onConfirm={() => { deleteFolder(confirmFolderDelete); setConfirmFolderDelete(null); }}
        />
      )}

      {confirmPurge && (
        <ConfirmDialog
          title="Permanently delete this page?"
          message="This action cannot be undone."
          confirmLabel="Delete Permanently"
          danger
          onCancel={() => setConfirmPurge(null)}
          onConfirm={() => { permanentlyDeletePage(confirmPurge); setConfirmPurge(null); }}
        />
      )}

      {migration && (
        <MigrationDialog
          pages={migration.pages}
          folders={migration.folders}
          onImport={handleMigrationImport}
          onSkip={handleMigrationSkip}
        />
      )}

      {folderPicker && (
        <FolderPickerModal
          mode={folderPicker}
          title={folderPicker === 'open' ? 'Open Folder' : 'New Workspace'}
          busy={folderPickerBusy}
          onCancel={() => setFolderPicker(null)}
          onSelect={handleFolderPickerSelect}
          onCreate={handleFolderPickerCreate}
        />
      )}
    </div>
  );
}