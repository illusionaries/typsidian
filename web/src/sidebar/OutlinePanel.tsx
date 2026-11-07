/**
 * OutlinePanel — the document heading tree.
 *
 * Language agnostic: it renders `OutlineItem[]` from the render result, indents
 * by depth, highlights the block under the caret and jumps on click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { OutlineItem } from '@shared/doc';
import type { OutlineProps } from '@web/contracts';

import { IconClose, IconSearch } from './icons';

import './sidebar.css';

/** Only show the filter once the outline gets long. */
const FILTER_THRESHOLD = 5;

export function OutlinePanel({ outline, activeBlockId, onJump, onClose }: OutlineProps) {
  const [query, setQuery] = useState('');
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return outline;
    return outline.filter((item) => item.text.toLowerCase().includes(needle));
  }, [outline, query]);

  // Keep the heading that matches the caret in view.
  useEffect(() => {
    if (!activeBlockId) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeBlockId]);

  const showFilter = outline.length > FILTER_THRESHOLD;

  return (
    <div className="tp-sidebar tp-outline">
      <header className="tp-sidebar__header">
        <span className="tp-sidebar__title">
          <span>Outline</span>
          {outline.length > 0 ? (
            <span className="tp-sidebar__count">{outline.length}</span>
          ) : null}
        </span>
        {onClose ? (
          <span className="tp-sidebar__actions">
            <button
              type="button"
              className="tp-icon-btn"
              title="Hide outline"
              aria-label="Hide outline"
              onClick={onClose}
            >
              <IconClose />
            </button>
          </span>
        ) : null}
      </header>

      {showFilter ? (
        <div className="tp-sidebar__search">
          <IconSearch className="tp-sidebar__search-icon" />
          <input
            value={query}
            placeholder="Filter headings…"
            aria-label="Filter outline"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (query) setQuery('');
              }
            }}
          />
        </div>
      ) : null}

      {outline.length === 0 ? (
        <div className="tp-sidebar__empty">
          No headings yet.
          <br />
          Add a heading to build an outline.
        </div>
      ) : visible.length === 0 ? (
        <div className="tp-sidebar__empty">No headings match “{query.trim()}”.</div>
      ) : (
        <nav className="tp-outline__list" aria-label="Document outline">
          {visible.map((item: OutlineItem) => {
            const depth = Math.min(Math.max(item.depth, 0), 8);
            const isActive = item.blockId === activeBlockId;
            return (
              <button
                key={item.id}
                type="button"
                ref={isActive ? activeRef : undefined}
                className={`tp-outline__item${isActive ? ' is-active' : ''}`}
                style={{ paddingLeft: 10 + depth * 14 }}
                data-depth={depth}
                data-block-id={item.blockId}
                aria-current={isActive ? 'location' : undefined}
                onClick={() => onJump(item)}
                title={item.text || 'Untitled'}
              >
                <span className="tp-outline__dot" aria-hidden="true" />
                <span className="tp-outline__text">{item.text || 'Untitled'}</span>
              </button>
            );
          })}
        </nav>
      )}

      {outline.length > 0 ? (
        <div className="tp-outline__hint">Click a heading to jump to its source.</div>
      ) : null}
    </div>
  );
}

export default OutlinePanel;
