import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import type { FindReplaceStorage } from './extensions/FindReplace';

export function FindBar({ editor, onClose, showReplace }: { editor: Editor; onClose: () => void; showReplace: boolean }) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const storage = editor.storage.findReplace as FindReplaceStorage;

  const runSearch = (q: string, opts?: Partial<Pick<FindReplaceStorage, 'matchCase' | 'wholeWord' | 'useRegex'>>) => {
    (editor.commands as any).setFindQuery(q, { matchCase, wholeWord, useRegex, ...opts });
  };

  useEffect(() => {
    runSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeWord, useRegex]);

  useEffect(() => () => { (editor.commands as any).clearFind(); }, [editor]);

  const count = storage.matches.length;
  const activeIndex = storage.activeIndex;

  const scrollToActive = () => {
    const m = storage.matches[storage.activeIndex];
    if (!m) return;
    const dom = editor.view.domAtPos(m.from);
    const el = (dom.node instanceof Element ? dom.node : dom.node.parentElement) as Element | null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    <div className="find-bar" role="dialog" aria-label="Find and replace">
      <div className="find-row">
        <input
          ref={inputRef}
          className="find-input"
          placeholder="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (editor.commands as any)[e.shiftKey ? 'findPrev' : 'findNext']();
              scrollToActive();
            }
            if (e.key === 'Escape') onClose();
          }}
        />
        <span className="find-count">{count > 0 ? `${activeIndex + 1} / ${count}` : '0 / 0'}</span>
        <button className="icon-btn" title="Previous match" onClick={() => { (editor.commands as any).findPrev(); scrollToActive(); }} disabled={!count}><ChevronUp size={16} /></button>
        <button className="icon-btn" title="Next match" onClick={() => { (editor.commands as any).findNext(); scrollToActive(); }} disabled={!count}><ChevronDown size={16} /></button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
      </div>

      {showReplace && (
        <div className="find-row">
          <input
            className="find-input"
            placeholder="Replace"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
          <button className="text-btn" onClick={() => (editor.commands as any).replaceActive(replacement)} disabled={!count}>Replace</button>
          <button className="text-btn" onClick={() => (editor.commands as any).replaceAll(replacement)} disabled={!count}>Replace All</button>
        </div>
      )}

      <div className="find-options">
        <label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole word</label>
        <label><input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} /> Regex</label>
      </div>
    </div>
  );
}
