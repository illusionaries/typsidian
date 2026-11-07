/**
 * FileTree — the vault sidebar.
 *
 * Controlled by the app shell (workspace snapshot + callbacks), but keeps a
 * small optimistic overlay so create/rename/delete feel instant while the
 * shell refreshes the real listing. Rejected callbacks surface as inline
 * errors instead of disappearing into the console.
 *
 * Keyboard: ↑/↓ moves, ←/→ collapses/expands, Enter opens, F2 renames,
 * Delete asks for confirmation, `/` focuses the filter.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { FileEntry } from '@shared/protocol';
import type { FileTreeProps } from '@web/contracts';

import {
  IconChevron,
  IconClose,
  IconDoc,
  IconFolder,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconWarning,
} from './icons';
import {
  ancestorDirs,
  applyOverlay,
  buildTree,
  dirName,
  EMPTY_OVERLAY,
  flattenTree,
  languageBadge,
  normalizeNewFile,
  normalizeRenamedFile,
  pathDepth,
  pruneOverlay,
  treeRowKey,
  withCreated,
  withRemoved,
  withRenamed,
} from './tree';
import type { DirRow, FileRow, TreeOverlay, TreeRow } from './tree';

import './sidebar.css';

interface CreateDraft {
  value: string;
  /** Folder the new file is created in ('' = vault root). */
  directory: string;
  error: string | null;
  busy: boolean;
}

interface RenameDraft {
  path: string;
  value: string;
  error: string | null;
  busy: boolean;
}

const NO_FILES: FileEntry[] = [];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function FileTree({
  workspace,
  activePath,
  dirtyPaths,
  onOpen,
  onCreateFile,
  onRename,
  onDelete,
  onRefresh,
  onClose,
}: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [query, setQuery] = useState('');
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [create, setCreate] = useState<CreateDraft | null>(null);
  const [rename, setRename] = useState<RenameDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<TreeOverlay>(EMPTY_OVERLAY);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const dirty = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const files = useMemo(
    () => applyOverlay(workspace?.files ?? NO_FILES, overlay),
    [workspace, overlay],
  );
  const tree = useMemo(
    () => buildTree(files, workspace?.title ?? 'Vault'),
    [files, workspace?.title],
  );
  const rows = useMemo(() => flattenTree(tree, collapsed, query), [tree, collapsed, query]);

  const rovingKey = useMemo(() => {
    if (focusedPath && rows.some((row) => treeRowKey(row) === focusedPath)) {
      return focusedPath;
    }
    return rows.length > 0 ? treeRowKey(rows[0]) : null;
  }, [focusedPath, rows]);

  const creating = create !== null;
  const renamingPath = rename?.path ?? null;

  // Drop optimistic entries as soon as a fresh workspace listing includes them.
  useEffect(() => {
    if (!workspace) return;
    setOverlay((previous) => pruneOverlay(previous, workspace.files));
  }, [workspace]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!renamingPath) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    // Select the base name; keep the extension out of the selection.
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, [renamingPath]);

  // Keep the active document reachable and visible.
  useEffect(() => {
    if (!activePath) return;
    const ancestors = ancestorDirs(activePath);
    setCollapsed((previous) => {
      if (!ancestors.some((directory) => previous.has(directory))) return previous;
      const next = new Set(previous);
      for (const directory of ancestors) next.delete(directory);
      return next;
    });
    setFocusedPath(`file:${activePath}`);
  }, [activePath]);

  useEffect(() => {
    if (!activePath) return;
    const key = `file:${activePath}`;
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(key)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activePath]);

  // ------------------------------------------------------------- helpers ---

  const toggleDirectory = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAncestorsOf = (path: string): void => {
    const ancestors = ancestorDirs(path);
    if (ancestors.length === 0) return;
    setCollapsed((previous) => {
      if (!ancestors.some((directory) => previous.has(directory))) return previous;
      const next = new Set(previous);
      for (const directory of ancestors) next.delete(directory);
      return next;
    });
  };

  const fileExists = (path: string): boolean => files.some((file) => file.path === path);

  const focusRow = (index: number): void => {
    if (rows.length === 0) return;
    const bounded = Math.min(Math.max(index, 0), rows.length - 1);
    const row = rows[bounded];
    if (!row) return;
    const key = treeRowKey(row);
    setFocusedPath(key);
    rowRefs.current.get(key)?.focus();
  };

  const beginCreate = (): void => {
    if (!workspace) return;
    setRename(null);
    setPendingDelete(null);
    setError(null);
    const focusedDirectory =
      focusedPath && focusedPath.startsWith('dir:') ? focusedPath.slice(4) : '';
    setCreate({
      value: '',
      directory: focusedDirectory || dirName(activePath ?? ''),
      error: null,
      busy: false,
    });
  };

  const beginRename = (entry: FileEntry): void => {
    setCreate(null);
    setPendingDelete(null);
    setError(null);
    setRename({ path: entry.path, value: entry.name, error: null, busy: false });
  };

  const requestDelete = (path: string): void => {
    setCreate(null);
    setRename(null);
    setError(null);
    setPendingDelete(path);
    setFocusedPath(`file:${path}`);
  };

  // ------------------------------------------------------------- actions ---

  const submitCreate = async (): Promise<void> => {
    if (!create || create.busy) return;
    const path = normalizeNewFile(create.value, create.directory);
    if (!path) {
      setCreate({ ...create, error: 'Enter a file name' });
      return;
    }
    if (fileExists(path)) {
      setCreate({ ...create, error: `${path} already exists` });
      return;
    }
    setCreate({ ...create, busy: true, error: null });
    try {
      await onCreateFile(path);
      setOverlay((previous) => withCreated(previous, path));
      setCreate(null);
      if (query) setQuery('');
      expandAncestorsOf(path);
      setFocusedPath(`file:${path}`);
      onOpen(path);
    } catch (caught) {
      setCreate((current) =>
        current ? { ...current, busy: false, error: messageOf(caught) } : current,
      );
    }
  };

  const submitRename = async (): Promise<void> => {
    if (!rename || rename.busy) return;
    const from = rename.path;
    const to = normalizeRenamedFile(from, rename.value);
    if (!to) {
      setRename({ ...rename, error: 'Enter a file name' });
      return;
    }
    if (to === from) {
      setRename(null);
      return;
    }
    if (fileExists(to)) {
      setRename({ ...rename, error: 'That name is already taken' });
      return;
    }
    setRename({ ...rename, busy: true, error: null });
    try {
      await onRename(from, to);
      setOverlay((previous) => withRenamed(previous, from, to));
      setRename(null);
      expandAncestorsOf(to);
      setFocusedPath(`file:${to}`);
    } catch (caught) {
      setRename((current) =>
        current ? { ...current, busy: false, error: messageOf(caught) } : current,
      );
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || deleteBusy) return;
    const path = pendingDelete;
    setDeleteBusy(true);
    try {
      await onDelete(path);
      setOverlay((previous) => withRemoved(previous, path));
      setPendingDelete(null);
      setError(null);
    } catch (caught) {
      setPendingDelete(null);
      setError(`Could not delete ${path}: ${messageOf(caught)}`);
    } finally {
      setDeleteBusy(false);
    }
  };

  // ------------------------------------------------------------- keyboard --

  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;

    // Esc always cancels an inline delete confirmation, wherever focus is.
    if (event.key === 'Escape' && pendingDelete && !deleteBusy) {
      event.preventDefault();
      setPendingDelete(null);
      return;
    }
    if (target.closest('input, textarea, button')) return;

    const rowElement = target.closest<HTMLElement>('[data-row-key]');
    const currentKey = rowElement?.dataset.rowKey ?? focusedPath ?? '';
    const index = rows.findIndex((row) => treeRowKey(row) === currentKey);
    const row = index >= 0 ? rows[index] : null;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index < 0 ? 0 : index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index < 0 ? 0 : index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        return;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (!row) return;
        if (row.kind === 'dir' && !row.expanded) toggleDirectory(row.path);
        else focusRow(index + 1);
        return;
      case 'ArrowLeft': {
        event.preventDefault();
        if (!row) return;
        if (row.kind === 'dir' && row.expanded) {
          toggleDirectory(row.path);
          return;
        }
        for (let candidate = index - 1; candidate >= 0; candidate--) {
          const previous = rows[candidate];
          if (previous.kind === 'dir' && previous.depth < row.depth) {
            focusRow(candidate);
            return;
          }
        }
        return;
      }
      case 'Enter':
        event.preventDefault();
        if (!row) return;
        if (row.kind === 'dir') toggleDirectory(row.path);
        else onOpen(row.entry.path);
        return;
      case 'F2':
        event.preventDefault();
        if (row?.kind === 'file') beginRename(row.entry);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (row?.kind === 'file') requestDelete(row.path);
        return;
      case 'Escape':
        event.preventDefault();
        if (query) setQuery('');
        else {
          setFocusedPath(null);
          target.blur();
        }
        return;
      case '/':
        event.preventDefault();
        searchRef.current?.focus();
        return;
      default:
        return;
    }
  };

  // ------------------------------------------------------------- rendering --

  const registerRow = (key: string) => (element: HTMLDivElement | null): void => {
    if (element) rowRefs.current.set(key, element);
    else rowRefs.current.delete(key);
  };

  const renderDirRow = (row: DirRow) => {
    const key = treeRowKey(row);
    return (
      <div
        key={key}
        ref={registerRow(key)}
        className="tp-tree__row tp-tree__row--dir"
        style={{ paddingLeft: 8 + row.depth * 14 }}
        data-row-key={key}
        data-kind="dir"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.expanded}
        tabIndex={key === rovingKey ? 0 : -1}
        title={row.path}
        onFocus={() => setFocusedPath(key)}
        onClick={() => toggleDirectory(row.path)}
      >
        <IconChevron expanded={row.expanded} className="tp-tree__chevron" />
        <IconFolder className="tp-tree__icon" />
        <span className="tp-tree__name">{row.name}</span>
        <span className="tp-tree__count">{row.count}</span>
      </div>
    );
  };

  const renderFileRow = (row: FileRow) => {
    const key = treeRowKey(row);
    const entry = row.entry;
    const indent = 8 + row.depth * 14;
    const isActive = activePath === entry.path;
    const isDirty = dirty.has(entry.path);

    if (rename && rename.path === entry.path) {
      const draft = rename;
      return (
        <Fragment key={key}>
          <div
            className="tp-tree__row tp-tree__row--file"
            style={{ paddingLeft: indent }}
            data-row-key={key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isActive}
            aria-busy={draft.busy}
            tabIndex={-1}
          >
            <IconDoc className="tp-tree__icon" />
            <input
              ref={renameInputRef}
              className="tp-tree__input"
              value={draft.value}
              disabled={draft.busy}
              aria-label={`New name for ${entry.name}`}
              spellCheck={false}
              onChange={(event) =>
                setRename({ ...draft, value: event.target.value, error: null })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setRename(null);
                }
              }}
              onBlur={() => {
                if (!draft.busy && !draft.error) setRename(null);
              }}
            />
            {draft.busy ? <span className="tp-tree__spinner" aria-label="Renaming" /> : null}
          </div>
          {draft.error ? (
            <div
              className="tp-tree__inline-error"
              role="alert"
              style={{ paddingLeft: indent + 18 }}
            >
              {draft.error}
            </div>
          ) : null}
        </Fragment>
      );
    }

    if (pendingDelete === entry.path) {
      return (
        <div
          key={key}
          className="tp-tree__row tp-tree__row--confirm"
          style={{ paddingLeft: indent }}
          data-row-key={key}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={isActive}
        >
          <IconTrash className="tp-tree__icon" style={{ color: 'var(--danger)' }} />
          <span className="tp-tree__confirm-text">Delete “{entry.name}”?</span>
          <button
            type="button"
            className="tp-btn tp-btn--danger"
            autoFocus
            disabled={deleteBusy}
            onClick={(event) => {
              event.stopPropagation();
              void confirmDelete();
            }}
          >
            {deleteBusy ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="tp-btn"
            disabled={deleteBusy}
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete(null);
            }}
          >
            Cancel
          </button>
        </div>
      );
    }

    const directory = row.showPath ? dirName(entry.path) : '';
    return (
      <div
        key={key}
        ref={registerRow(key)}
        className={`tp-tree__row tp-tree__row--file${isActive ? ' is-active' : ''}`}
        style={{ paddingLeft: indent }}
        data-row-key={key}
        data-kind="file"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={isActive}
        tabIndex={key === rovingKey ? 0 : -1}
        title={entry.path}
        onFocus={() => setFocusedPath(key)}
        onClick={() => onOpen(entry.path)}
        onDoubleClick={() => beginRename(entry)}
      >
        <IconDoc className="tp-tree__icon" />
        {isDirty ? (
          <span
            className="tp-tree__dirty"
            role="img"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        ) : null}
        <span className="tp-tree__name">
          {directory ? <span className="tp-tree__path">{directory}/</span> : null}
          {entry.name}
        </span>
        <span className="tp-tree__badge">{languageBadge(entry)}</span>
        <span className="tp-tree__actions">
          <button
            type="button"
            className="tp-icon-btn tp-icon-btn--small"
            title="Rename"
            aria-label={`Rename ${entry.name}`}
            onClick={(event) => {
              event.stopPropagation();
              beginRename(entry);
            }}
          >
            <IconPencil />
          </button>
          <button
            type="button"
            className="tp-icon-btn tp-icon-btn--small tp-icon-btn--danger"
            title="Delete"
            aria-label={`Delete ${entry.name}`}
            onClick={(event) => {
              event.stopPropagation();
              requestDelete(entry.path);
            }}
          >
            <IconTrash />
          </button>
        </span>
      </div>
    );
  };

  const createRow = create ? (
    <div className="tp-tree__create" role="none">
      <div
        className="tp-tree__create-row"
        style={{ paddingLeft: 8 + pathDepth(create.directory) * 14 }}
      >
        {create.directory ? (
          <span className="tp-tree__create-prefix" title={create.directory}>
            {create.directory}/
          </span>
        ) : null}
        <input
          ref={createInputRef}
          className="tp-tree__input"
          value={create.value}
          placeholder="name.typ"
          aria-label={create.directory ? `New file in ${create.directory}` : 'New file name'}
          spellCheck={false}
          disabled={create.busy}
          onChange={(event) => setCreate({ ...create, value: event.target.value, error: null })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submitCreate();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setCreate(null);
            }
          }}
        />
        {create.busy ? <span className="tp-tree__spinner" aria-label="Creating file" /> : null}
      </div>
      {create.error ? (
        <div className="tp-tree__inline-error" role="alert">
          {create.error}
        </div>
      ) : null}
    </div>
  ) : null;

  const emptyState = (
    <div className="tp-sidebar__empty" role="none">
      {query.trim() ? (
        <>No files match “{query.trim()}”.</>
      ) : (
        <>
          This vault is empty. Use <strong>+</strong> to create a document.
        </>
      )}
    </div>
  );

  return (
    <div className="tp-sidebar tp-filetree">
      <header className="tp-sidebar__header">
        <span className="tp-sidebar__title" title={workspace?.root ?? undefined}>
          <span>{workspace?.title ?? 'Vault'}</span>
          {workspace ? <span className="tp-sidebar__count">{files.length}</span> : null}
        </span>
        <span className="tp-sidebar__actions">
          <button
            type="button"
            className="tp-icon-btn"
            title="New file"
            aria-label="New file"
            disabled={!workspace}
            onClick={beginCreate}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="tp-icon-btn"
            title="Refresh vault"
            aria-label="Refresh vault"
            onClick={onRefresh}
          >
            <IconRefresh />
          </button>
          {onClose ? (
            <button
              type="button"
              className="tp-icon-btn"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              onClick={onClose}
            >
              <IconClose />
            </button>
          ) : null}
        </span>
      </header>

      <div className="tp-sidebar__search">
        <IconSearch className="tp-sidebar__search-icon" />
        <input
          ref={searchRef}
          value={query}
          placeholder="Filter files…"
          aria-label="Filter files"
          title="Filter by name — start with > to list every file"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery('');
              else searchRef.current?.blur();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusRow(0);
            } else if (event.key === 'Enter') {
              const firstFile = rows.find((row) => row.kind === 'file');
              if (firstFile?.kind === 'file') onOpen(firstFile.entry.path);
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="tp-sidebar__clear"
            aria-label="Clear filter"
            onClick={() => setQuery('')}
          >
            <IconClose />
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="tp-sidebar__error" role="alert">
          <IconWarning />
          <span className="tp-sidebar__error-text">{error}</span>
          <button
            type="button"
            className="tp-icon-btn tp-icon-btn--small"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            <IconClose />
          </button>
        </div>
      ) : null}

      {workspace ? (
        <div
          ref={treeRef}
          className="tp-tree"
          role="tree"
          aria-label="Vault files"
          onKeyDown={handleTreeKeyDown}
        >
          {createRow}
          {rows.length === 0 && !create ? emptyState : rows.map((row: TreeRow) =>
            row.kind === 'dir' ? renderDirRow(row) : renderFileRow(row),
          )}
        </div>
      ) : (
        <div className="tp-sidebar__empty">Loading vault…</div>
      )}
    </div>
  );
}

export default FileTree;
