import { useMemo, useState } from 'react';
import {
  Search, Star, Trash2, Settings, Plus, FolderPlus, ChevronRight, ChevronDown,
  Folder as FolderIcon, FolderOpen, FileText, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import type { Folder, Page } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { docToText } from '../utils/docText';

export type SidebarView = 'all' | 'favorites' | 'trash';

interface SidebarProps {
  folders: Folder[];
  pages: Page[];
  selectedPageId: string | null;
  view: SidebarView;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectPage: (id: string) => void;
  onSetView: (v: SidebarView) => void;
  onNewPage: (folderId: string | null) => void;
  onNewFolder: (parentId: string | null) => void;
  onRenamePage: (id: string, title: string) => void;
  onDuplicatePage: (id: string) => void;
  onSoftDeletePage: (id: string) => void;
  onRestorePage: (id: string) => void;
  onPermanentDeletePage: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onMovePage: (id: string, folderId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onOpenSettings: () => void;
  localMode?: boolean;
  onOpenFolder?: () => void;
  onNewWorkspace?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    folders, pages, selectedPageId, view, collapsed, onToggleCollapsed,
    onSelectPage, onSetView, onNewPage, onNewFolder, onRenamePage, onDuplicatePage,
    onSoftDeletePage, onRestorePage, onPermanentDeletePage, onToggleFavorite,
    onMovePage, onRenameFolder, onDeleteFolder, onOpenSettings,
    localMode = false, onOpenFolder, onNewWorkspace,
  } = props;

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<{ type: 'page' | 'folder'; id: string; value: string } | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null | undefined>(undefined);

  const activePages = useMemo(() => pages.filter((p) => !p.deleted), [pages]);
  const activeFolders = useMemo(() => folders.filter((f) => !f.deleted), [folders]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return activePages.filter((p) => p.title.toLowerCase().includes(q) || docToText(p.content).toLowerCase().includes(q));
  }, [query, activePages]);

  const rootFolders = activeFolders.filter((f) => f.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const rootPages = activePages.filter((p) => p.folderId === null).sort((a, b) => a.sortOrder - b.sortOrder);

  const toggleExpand = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  const openPageMenu = (e: React.MouseEvent, page: Page) => {
    e.preventDefault();
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Open', onClick: () => onSelectPage(page.id) },
        { label: 'Rename', onClick: () => setRenaming({ type: 'page', id: page.id, value: page.title }) },
        { label: 'Duplicate', onClick: () => onDuplicatePage(page.id) },
        { label: page.favorite ? 'Unfavorite' : 'Favorite', onClick: () => onToggleFavorite(page.id) },
        { label: 'Move to root', onClick: () => onMovePage(page.id, null) },
        { label: 'Delete', danger: true, onClick: () => onSoftDeletePage(page.id) },
      ],
    });
  };

  const openFolderMenu = (e: React.MouseEvent, folder: Folder) => {
    e.preventDefault();
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Rename', onClick: () => setRenaming({ type: 'folder', id: folder.id, value: folder.name }) },
        { label: 'New Page', onClick: () => onNewPage(folder.id) },
        { label: 'New Folder', onClick: () => onNewFolder(folder.id) },
        { label: 'Delete', danger: true, onClick: () => onDeleteFolder(folder.id) },
      ],
    });
  };

  const renderPage = (page: Page) => (
    <div
      key={page.id}
      className={`tree-item page-item${selectedPageId === page.id ? ' active' : ''}`}
      onClick={() => onSelectPage(page.id)}
      onContextMenu={(e) => openPageMenu(e, page)}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/page-id', page.id)}
    >
      <FileText size={14} className="tree-icon" />
      {renaming?.type === 'page' && renaming.id === page.id ? (
        <input
          autoFocus
          className="rename-input"
          value={renaming.value}
          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => { onRenamePage(page.id, renaming.value.trim() || 'Untitled'); setRenaming(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onRenamePage(page.id, renaming.value.trim() || 'Untitled'); setRenaming(null); }
            if (e.key === 'Escape') setRenaming(null);
          }}
        />
      ) : (
        <span className="tree-label">{page.title}</span>
      )}
      {page.favorite && <Star size={12} className="favorite-dot" fill="currentColor" />}
    </div>
  );

  const renderFolder = (folder: Folder, depth: number) => {
    // Folders start collapsed: an id is only present in `expanded` once the
    // user has clicked that folder, so nothing auto-expands on (re)open.
    const isOpen = expanded[folder.id] ?? false;
    const childFolders = activeFolders.filter((f) => f.parentId === folder.id).sort((a, b) => a.sortOrder - b.sortOrder);
    const childPages = activePages.filter((p) => p.folderId === folder.id).sort((a, b) => a.sortOrder - b.sortOrder);
    return (
      <div key={folder.id} style={{ marginLeft: depth ? 12 : 0 }}>
        <div
          className={`tree-item folder-item${dragOverFolder === folder.id ? ' drag-over' : ''}`}
          onClick={() => toggleExpand(folder.id)}
          onContextMenu={(e) => openFolderMenu(e, folder)}
          onDragOver={(e) => { e.preventDefault(); setDragOverFolder(folder.id); }}
          onDragLeave={() => setDragOverFolder(undefined)}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/page-id');
            if (id) onMovePage(id, folder.id);
            setDragOverFolder(undefined);
          }}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FolderIcon size={14} className="tree-icon" />
          {renaming?.type === 'folder' && renaming.id === folder.id ? (
            <input
              autoFocus
              className="rename-input"
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => { onRenameFolder(folder.id, renaming.value.trim() || 'Folder'); setRenaming(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onRenameFolder(folder.id, renaming.value.trim() || 'Folder'); setRenaming(null); }
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span className="tree-label">{folder.name}</span>
          )}
        </div>
        {isOpen && (
          <div className="tree-children">
            {childFolders.map((f) => renderFolder(f, depth + 1))}
            <div style={{ marginLeft: 12 }}>{childPages.map(renderPage)}</div>
          </div>
        )}
      </div>
    );
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="icon-btn" onClick={onToggleCollapsed} title="Expand sidebar"><PanelLeftOpen size={18} /></button>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="workspace-name">PERSONAL WORKSPACE</span>
        <button className="icon-btn" onClick={onToggleCollapsed} title="Collapse sidebar"><PanelLeftClose size={16} /></button>
      </div>

      <div className="sidebar-search">
        <Search size={14} />
        <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="sidebar-views">
        <button className={`view-btn${view === 'all' && !query ? ' active' : ''}`} onClick={() => onSetView('all')}>
          <FileText size={14} /> All pages
        </button>
        <button className={`view-btn${view === 'favorites' ? ' active' : ''}`} onClick={() => onSetView('favorites')}>
          <Star size={14} /> Favorites
        </button>
        <button className={`view-btn${view === 'trash' ? ' active' : ''}`} onClick={() => onSetView('trash')}>
          <Trash2 size={14} /> Trash
        </button>
      </div>

      <div className="sidebar-tree">
        {searchResults ? (
          searchResults.length ? searchResults.map(renderPage) : <div className="empty-hint">No matches</div>
        ) : view === 'trash' ? (
          pages.filter((p) => p.deleted).length ? (
            pages.filter((p) => p.deleted).map((page) => (
              <div key={page.id} className="tree-item page-item">
                <FileText size={14} className="tree-icon" />
                <span className="tree-label">{page.title}</span>
                <div className="trash-actions">
                  <button className="text-btn" onClick={() => onRestorePage(page.id)}>Restore</button>
                  <button className="text-btn danger" onClick={() => onPermanentDeletePage(page.id)}>Delete</button>
                </div>
              </div>
            ))
          ) : <div className="empty-hint">Trash is empty</div>
        ) : view === 'favorites' ? (
          activePages.filter((p) => p.favorite).length
            ? activePages.filter((p) => p.favorite).map(renderPage)
            : <div className="empty-hint">No favorites yet</div>
        ) : (
          <>
            {rootFolders.map((f) => renderFolder(f, 0))}
            {rootPages.map(renderPage)}
            {!rootFolders.length && !rootPages.length && (
              <div className="empty-hint">No pages yet. Create your first page below.</div>
            )}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        {localMode && (
          <div className="sidebar-local-actions">
            <button className="footer-btn" onClick={() => onOpenFolder?.()}><FolderOpen size={14} /> Open Folder…</button>
            <button className="footer-btn" onClick={() => onNewWorkspace?.()}><FolderPlus size={14} /> New Workspace…</button>
            <div className="sidebar-footer-sep" />
          </div>
        )}
        <button className="footer-btn" onClick={() => onNewPage(null)}><Plus size={14} /> New Page</button>
        <button className="footer-btn" onClick={() => onNewFolder(null)}><FolderPlus size={14} /> New Folder</button>
        <button className="footer-btn" onClick={onOpenSettings}><Settings size={14} /> Settings</button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
