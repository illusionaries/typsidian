/**
 * Pure helpers for the sidebar file tree.
 *
 * Everything here is framework-free and side-effect-free: the React component
 * only renders what these functions produce.
 */

import type { FileEntry } from '@shared/protocol';

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

export interface DirNode {
  kind: 'dir';
  name: string;
  /** Vault-relative path, `''` for the root. */
  path: string;
  children: TreeNode[];
  /** Number of documents below this folder (recursive). */
  fileCount: number;
}

export interface FileNode {
  kind: 'file';
  path: string;
  entry: FileEntry;
}

export type TreeNode = DirNode | FileNode;

/** One rendered row of the tree, already flattened in display order. */
export interface DirRow {
  kind: 'dir';
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  count: number;
}

export interface FileRow {
  kind: 'file';
  path: string;
  entry: FileEntry;
  depth: number;
  /** Render the full vault path instead of just the base name (`> ` mode). */
  showPath: boolean;
}

export type TreeRow = DirRow | FileRow;

/** Stable key for a row, also used by the roving-focus logic. */
export function treeRowKey(row: TreeRow): string {
  return `${row.kind}:${row.path}`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

export function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

export function extensionOf(path: string): string {
  const base = baseName(path);
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index) : '';
}

/** Directory depth of a vault path (`notes/a.typ` -> 1, `a.typ` -> 0). */
export function pathDepth(path: string): number {
  return path.split('/').filter((segment) => segment.length > 0).length;
}

/** Every ancestor folder of a path, closest first, outermost last. */
export function ancestorDirs(path: string): string[] {
  const directories: string[] = [];
  let current = dirName(path);
  while (current) {
    directories.push(current);
    current = dirName(current);
  }
  return directories;
}

/** A synthetic entry for a file that exists only optimistically (not fetched). */
export function makeFileEntry(path: string): FileEntry {
  const name = baseName(path);
  return {
    path,
    name,
    language: extensionOf(name).toLowerCase() === '.typ' ? 'typst' : 'plain',
    mtime: Date.now(),
    size: 0,
  };
}

/**
 * Short badge shown on file rows. Prefers the extension (stable, human) and
 * falls back to the language id.
 */
export function languageBadge(file: { name: string; language: string }): string {
  const extension = extensionOf(file.name).toLowerCase();
  switch (extension) {
    case '.typ':
      return 'TYP';
    case '.md':
    case '.markdown':
      return 'MD';
    case '.txt':
      return 'TXT';
    case '.json':
      return 'JSON';
    case '.yml':
    case '.yaml':
      return 'YML';
    case '.toml':
      return 'TOML';
    case '.csv':
      return 'CSV';
    default: {
      const raw = extension.replace(/^\./, '').toUpperCase();
      if (raw) return raw.slice(0, 4);
      return file.language === 'typst' ? 'TYP' : 'DOC';
    }
  }
}

// ---------------------------------------------------------------------------
// Building + flattening
// ---------------------------------------------------------------------------

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind === 'dir') {
    if (b.kind === 'file') return -1;
    return a.name.localeCompare(b.name);
  }
  if (b.kind === 'dir') return 1;
  return a.entry.path.localeCompare(b.entry.path);
}

function decorate(node: DirNode): number {
  node.children.sort(compareNodes);
  let count = 0;
  for (const child of node.children) {
    count += child.kind === 'dir' ? decorate(child) : 1;
  }
  node.fileCount = count;
  return count;
}

/** Build the collapsible folder hierarchy for a flat vault listing. */
export function buildTree(files: FileEntry[], rootName: string): DirNode {
  const root: DirNode = { kind: 'dir', name: rootName, path: '', children: [], fileCount: 0 };
  const directories = new Map<string, DirNode>([['', root]]);

  const ensureDirectory = (path: string): DirNode => {
    const existing = directories.get(path);
    if (existing) return existing;
    const parent = ensureDirectory(dirName(path));
    const node: DirNode = { kind: 'dir', name: baseName(path), path, children: [], fileCount: 0 };
    parent.children.push(node);
    directories.set(path, node);
    return node;
  };

  for (const entry of files) {
    ensureDirectory(dirName(entry.path)).children.push({
      kind: 'file',
      path: entry.path,
      entry,
    });
  }

  decorate(root);
  return root;
}

function fileMatches(entry: FileEntry, needle: string): boolean {
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.path.toLowerCase().includes(needle)
  );
}

function directoryMatches(node: DirNode, needle: string): boolean {
  for (const child of node.children) {
    if (child.kind === 'dir' ? directoryMatches(child, needle) : fileMatches(child.entry, needle)) {
      return true;
    }
  }
  return false;
}

/**
 * Flatten the tree into the rows the component renders.
 *
 * - Folders collapse; filtering force-expands so matches are always visible.
 * - A query starting with `>` switches to a flat, path-sorted list of every
 *   document ("list all files" mode).
 */
export function flattenTree(
  root: DirNode,
  collapsed: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  const text = query.trim();

  if (text.startsWith('>')) {
    const needle = text.slice(1).trim().toLowerCase();
    const rows: FileRow[] = [];
    const collect = (node: DirNode): void => {
      for (const child of node.children) {
        if (child.kind === 'dir') {
          collect(child);
          continue;
        }
        if (needle && !fileMatches(child.entry, needle)) continue;
        rows.push({
          kind: 'file',
          path: child.path,
          entry: child.entry,
          depth: 0,
          showPath: true,
        });
      }
    };
    collect(root);
    rows.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
    return rows;
  }

  const needle = text.toLowerCase();
  const filtering = needle.length > 0;
  const rows: TreeRow[] = [];

  const walk = (directory: DirNode, depth: number): void => {
    for (const child of directory.children) {
      if (child.kind === 'dir') {
        if (filtering && !directoryMatches(child, needle)) continue;
        const expanded = filtering ? true : !collapsed.has(child.path);
        rows.push({
          kind: 'dir',
          path: child.path,
          name: child.name,
          depth,
          expanded,
          count: child.fileCount,
        });
        if (expanded) walk(child, depth + 1);
        continue;
      }
      if (filtering && !fileMatches(child.entry, needle)) continue;
      rows.push({
        kind: 'file',
        path: child.path,
        entry: child.entry,
        depth,
        showPath: false,
      });
    }
  };

  walk(root, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Optimistic overlay
// ---------------------------------------------------------------------------

/**
 * Local changes applied on top of the last workspace snapshot so a create,
 * rename or delete is visible immediately, before the shell refreshes.
 * Every entry is dropped as soon as the real workspace listing reflects it.
 */
export interface TreeOverlay {
  added: FileEntry[];
  removed: string[];
  renamed: Array<{ from: string; entry: FileEntry }>;
}

export const EMPTY_OVERLAY: TreeOverlay = { added: [], removed: [], renamed: [] };

export function applyOverlay(files: FileEntry[], overlay: TreeOverlay): FileEntry[] {
  const removed = new Set(overlay.removed);
  const renamed = new Map(overlay.renamed.map((rename) => [rename.from, rename.entry]));
  const result: FileEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: FileEntry): void => {
    if (removed.has(entry.path) || seen.has(entry.path)) return;
    seen.add(entry.path);
    result.push(entry);
  };

  for (const file of files) push(renamed.get(file.path) ?? file);
  for (const entry of overlay.added) push(entry);

  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export function pruneOverlay(overlay: TreeOverlay, files: FileEntry[]): TreeOverlay {
  const paths = new Set(files.map((file) => file.path));
  const added = overlay.added.filter((entry) => !paths.has(entry.path));
  const removed = overlay.removed.filter((path) => paths.has(path));
  const renamed = overlay.renamed.filter((rename) => !paths.has(rename.entry.path));
  if (
    added.length === overlay.added.length &&
    removed.length === overlay.removed.length &&
    renamed.length === overlay.renamed.length
  ) {
    return overlay;
  }
  return { added, removed, renamed };
}

export function withCreated(overlay: TreeOverlay, path: string): TreeOverlay {
  if (overlay.added.some((entry) => entry.path === path)) return overlay;
  return {
    added: [...overlay.added, makeFileEntry(path)],
    removed: overlay.removed.filter((removed) => removed !== path),
    renamed: overlay.renamed.filter((rename) => rename.entry.path !== path),
  };
}

export function withRenamed(overlay: TreeOverlay, from: string, to: string): TreeOverlay {
  const wasAdded = overlay.added.some((entry) => entry.path === from);
  return {
    added: wasAdded
      ? overlay.added.map((entry) => (entry.path === from ? makeFileEntry(to) : entry))
      : overlay.added,
    removed: overlay.removed.filter((path) => path !== from && path !== to),
    renamed: wasAdded
      ? overlay.renamed.filter((rename) => rename.from !== from && rename.entry.path !== to)
      : [
          ...overlay.renamed.filter((rename) => rename.from !== from && rename.entry.path !== to),
          { from, entry: makeFileEntry(to) },
        ],
  };
}

export function withRemoved(overlay: TreeOverlay, path: string): TreeOverlay {
  const wasAdded = overlay.added.some((entry) => entry.path === path);
  return {
    added: overlay.added.filter((entry) => entry.path !== path),
    removed:
      wasAdded || overlay.removed.includes(path)
        ? overlay.removed
        : [...overlay.removed, path],
    renamed: overlay.renamed.filter(
      (rename) => rename.from !== path && rename.entry.path !== path,
    ),
  };
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Turn what the user typed in the "new file" field into a vault path:
 * - relative names are created inside `directory`
 * - a missing extension becomes `.typ`
 * - traversal (`..`) is rejected
 * Returns null when the input cannot be used.
 */
export function normalizeNewFile(raw: string, directory: string): string | null {
  const text = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!text) return null;
  const segments = text.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const base = trimSlashes(directory);
  let path = base ? `${base}/${segments.join('/')}` : segments.join('/');
  if (!/\.[^./]+$/.test(path)) path += '.typ';
  return path;
}

/**
 * Normalise the "rename" field. Only the file name may change; a missing
 * extension keeps the previous one.
 */
export function normalizeRenamedFile(from: string, raw: string): string | null {
  const name = raw.trim().replace(/\\/g, '/');
  if (!name || name.includes('/') || name === '.' || name === '..') return null;
  const directory = dirName(from);
  const currentExtension = extensionOf(from);
  let next = name;
  if (!/\.[^./]+$/.test(next) && currentExtension) next += currentExtension;
  return directory ? `${directory}/${next}` : next;
}
