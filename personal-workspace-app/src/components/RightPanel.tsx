import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { Page, OutlineHeading } from '../types';

interface RightPanelProps {
  page: Page | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  outline: OutlineHeading[];
  activeHeadingPos: number | null;
  onOutlineNavigate: (pos: number) => void;
  stats: { words: number; chars: number };
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function RightPanel({ page, collapsed, onToggleCollapsed, outline, activeHeadingPos, onOutlineNavigate, stats }: RightPanelProps) {
  if (collapsed) {
    return (
      <div className="right-panel right-panel-collapsed">
        <button className="icon-btn" onClick={onToggleCollapsed} title="Expand panel"><PanelRightOpen size={18} /></button>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="right-panel">
        <div className="right-panel-header">
          <span>DOCUMENT</span>
          <button className="icon-btn" onClick={onToggleCollapsed}><PanelRightClose size={16} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="right-panel">
      <div className="right-panel-header">
        <span>DOCUMENT</span>
        <button className="icon-btn" onClick={onToggleCollapsed}><PanelRightClose size={16} /></button>
      </div>

      <div className="right-panel-section">
        <div className="stat-row"><span>Words</span><span>{stats.words}</span></div>
        <div className="stat-row"><span>Characters</span><span>{stats.chars}</span></div>
      </div>

      <div className="right-panel-section">
        <div className="section-label">Created</div>
        <div className="section-value">{formatDate(page.createdAt)}</div>
      </div>

      <div className="right-panel-section">
        <div className="section-label">Modified</div>
        <div className="section-value">{formatDate(page.updatedAt)}</div>
      </div>

      <div className="right-panel-section">
        <div className="section-label">Outline</div>
        {outline.length === 0 && <div className="empty-hint">No headings yet</div>}
        {outline.map((h) => (
          <div
            key={h.pos}
            className={`outline-item${h.pos === activeHeadingPos ? ' active' : ''}`}
            style={{ paddingLeft: 6 + (h.level - 1) * 10 }}
            title={h.text}
            role="button"
            tabIndex={0}
            onClick={() => onOutlineNavigate(h.pos)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOutlineNavigate(h.pos);
              }
            }}
          >
            {h.text}
          </div>
        ))}
      </div>
    </div>
  );
}
