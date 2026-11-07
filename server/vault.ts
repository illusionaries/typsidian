/**
 * Workspace (vault) file operations.
 *
 * A vault is a plain directory of documents — like Obsidian, no database. All
 * paths crossing this module are relative, POSIX-style, and validated to stay
 * inside the root.
 *
 * The module also owns the vault *watcher*: a single `fs.watch` (recursive)
 * instance with a polling fallback, debounced into small batches of
 * {@link VaultEvent}s that the server exposes over Server-Sent Events.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  FileContent,
  FileEntry,
  RecentVault,
  SavedFile,
  WorkspaceInfo,
} from '../shared/protocol';
import { allAdapters, languageOf } from './engine/registry';

/** Directories never walked, listed or watched. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'target', '.typsidian']);
/** File suffixes treated as editor temp files. */
const IGNORED_FILE_SUFFIXES = ['~', '.swp', '.swx', '.tmp', '.temp'];
/** Extensions presented as editable documents. */
const TEXT_EXTENSIONS = new Set([
  '.typ',
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.csv',
]);
/** Content search refuses to load anything bigger than this. */
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** Longest line excerpt returned by content search. */
const MAX_SEARCH_PREVIEW = 160;
/** Defensive limit for the recursive walk (symlink loops are skipped anyway). */
const MAX_WALK_DEPTH = 64;

/** One content-search match inside a vault document. */
export interface SearchHit {
  /** Vault-relative path, POSIX separators. */
  path: string;
  name: string;
  language: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** The matching line, flattened and clipped for display. */
  preview: string;
}

export type VaultEventType = 'change' | 'add' | 'unlink';

/** One observed change in the vault, as pushed over `/api/events`. */
export interface VaultEvent {
  type: VaultEventType;
  /** Vault-relative path, POSIX separators. */
  path: string;
}

export interface VaultWatcherOptions {
  /** Coalescing window before a batch is emitted (default 150ms). */
  debounceMs?: number;
  /** Poll interval used when native watching is unavailable (default 1000ms). */
  pollMs?: number;
  /** Called for errors that are recovered from. Must not throw. */
  onError?(error: unknown): void;
}

/** Stat subset needed by the listing and the watcher. */
interface ScannedFile {
  mtime: number;
  size: number;
}

function isIgnoredDirectoryName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

function isIgnoredFileName(name: string): boolean {
  if (name.startsWith('.')) return true;
  return IGNORED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when a vault-relative path should never appear in listings/events. */
export function isIgnoredPath(relativePath: string): boolean {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  if (isIgnoredFileName(segments[segments.length - 1])) return true;
  return segments.slice(0, -1).some(isIgnoredDirectoryName);
}

function isTextFileName(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isInsideRoot(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** POSIX-style path relative to `root`. */
function toRelativePath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * Snapshot every document in the vault: relative path -> mtime/size.
 *
 * Resilient by design: unreadable directories, dangling symlinks and files
 * that vanish mid-scan are skipped instead of thrown.
 */
export function scanVault(root: string): Map<string, ScannedFile> {
  const files = new Map<string, ScannedFile>();
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (isIgnoredFileName(child.name)) continue;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        // `isDirectory()` is false for symlinks, so symlinked folders (and
        // their cycles) are never walked.
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (!child.isFile() && !child.isSymbolicLink()) continue;
      if (!isTextFileName(child.name)) continue;
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) continue;
        if (child.isSymbolicLink() && !isInsideRoot(root, fs.realpathSync(absolute))) {
          continue;
        }
        files.set(toRelativePath(root, absolute), { mtime: stat.mtimeMs, size: stat.size });
      } catch {
        // File disappeared or is unreadable: ignore it.
      }
    }
  };
  walk(root, 0);
  return files;
}

function searchPreview(line: string, needle: string): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_SEARCH_PREVIEW) return flat;
  const index = flat.toLowerCase().indexOf(needle);
  const start = Math.max(0, index < 0 ? 0 : index - 60);
  const clipped = flat.slice(start, start + MAX_SEARCH_PREVIEW);
  return `${start > 0 ? '…' : ''}${clipped}${start + MAX_SEARCH_PREVIEW < flat.length ? '…' : ''}`;
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(this.root).isDirectory()) {
      throw new Error(`vault root is not a directory: ${this.root}`);
    }
  }

  /** Absolute path for a vault-relative path, rejecting escapes. */
  resolve(relativePath: string): string {
    const cleaned = relativePath.replace(/^\/+/, '');
    const absolute = path.resolve(this.root, cleaned);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`path escapes the vault: ${relativePath}`);
    }
    return absolute;
  }

  relative(absolutePath: string): string {
    return toRelativePath(this.root, absolutePath);
  }

  list(): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const [relativePath, scanned] of scanVault(this.root)) {
      const name = path.posix.basename(relativePath);
      entries.push({
        path: relativePath,
        name,
        language: languageOf(name),
        mtime: scanned.mtime,
        size: scanned.size,
      });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  info(): WorkspaceInfo {
    return {
      root: this.root,
      title: path.basename(this.root),
      files: this.list(),
      languages: allAdapters().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        extensions: [...adapter.extensions],
      })),
    };
  }

  read(relativePath: string): FileContent {
    const absolute = this.resolve(relativePath);
    this.guardSymlinks(absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    const stat = fs.statSync(absolute);
    return {
      path: this.relative(absolute),
      source,
      mtime: stat.mtimeMs,
      language: languageOf(absolute),
    };
  }

  write(relativePath: string, source: string): SavedFile {
    const absolute = this.resolve(relativePath);
    this.guardSymlinks(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    const stat = fs.statSync(absolute);
    return { path: this.relative(absolute), mtime: stat.mtimeMs };
  }

  create(relativePath: string, source = ''): FileEntry {
    const absolute = this.resolve(relativePath);
    this.guardSymlinks(absolute);
    if (fs.existsSync(absolute)) {
      throw new Error(`file already exists: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    const stat = fs.statSync(absolute);
    return {
      path: this.relative(absolute),
      name: path.basename(absolute),
      language: languageOf(absolute),
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }

  /** Create a folder (and any missing parents). Returns the relative path. */
  mkdir(relativePath: string): string {
    if (!relativePath.trim()) throw new Error('missing folder path');
    const absolute = this.resolve(relativePath);
    this.guardSymlinks(absolute);
    fs.mkdirSync(absolute, { recursive: true });
    if (!fs.statSync(absolute).isDirectory()) {
      throw new Error(`not a directory: ${relativePath}`);
    }
    return this.relative(absolute);
  }

  rename(from: string, to: string): { from: string; to: string; entry: FileEntry } {
    const fromAbsolute = this.resolve(from);
    const toAbsolute = this.resolve(to);
    this.guardSymlinks(fromAbsolute);
    this.guardSymlinks(toAbsolute);
    if (!fs.existsSync(fromAbsolute)) throw new Error(`file not found: ${from}`);
    if (fromAbsolute === toAbsolute) throw new Error(`source and destination are identical: ${from}`);
    if (fs.existsSync(toAbsolute)) throw new Error(`destination already exists: ${to}`);
    fs.mkdirSync(path.dirname(toAbsolute), { recursive: true });
    fs.renameSync(fromAbsolute, toAbsolute);
    const stat = fs.statSync(toAbsolute);
    return {
      from: this.relative(fromAbsolute),
      to: this.relative(toAbsolute),
      entry: {
        path: this.relative(toAbsolute),
        name: path.basename(toAbsolute),
        language: languageOf(toAbsolute),
        mtime: stat.mtimeMs,
        size: stat.size,
      },
    };
  }

  remove(relativePath: string): void {
    const absolute = this.resolve(relativePath);
    if (absolute === this.root) throw new Error('refusing to remove the vault root');
    this.guardSymlinks(absolute);
    if (!fs.existsSync(absolute)) throw new Error(`file not found: ${relativePath}`);
    fs.rmSync(absolute, { recursive: false, force: false });
  }

  /** Absolute path used by adapters. */
  absolute(relativePath: string): string {
    return this.resolve(relativePath);
  }

  /** Quick plain-text search across the vault. */
  search(query: string, limit = 50): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    const paths = [...scanVault(this.root).keys()].sort((a, b) => a.localeCompare(b));
    for (const relativePath of paths) {
      if (hits.length >= limit) break;
      const absolute = this.resolve(relativePath);
      let source: string;
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
        source = fs.readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const column = lines[index].toLowerCase().indexOf(needle);
        if (column < 0) continue;
        hits.push({
          path: relativePath,
          name: path.posix.basename(relativePath),
          language: languageOf(relativePath),
          line: index + 1,
          column: column + 1,
          preview: searchPreview(lines[index], needle),
        });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  /**
   * Reject paths whose real location (through symlinks) leaves the vault.
   * For paths that do not exist yet the closest existing ancestor is checked,
   * which is enough because the missing tail cannot be a symlink.
   */
  private guardSymlinks(absolute: string): void {
    let probe = absolute;
    for (;;) {
      let real: string | null = null;
      try {
        real = fs.realpathSync(probe);
      } catch {
        real = null;
      }
      if (real !== null) {
        if (!isInsideRoot(this.root, real)) {
          throw new Error(`path escapes the vault: ${this.relative(absolute)}`);
        }
        return;
      }
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

/**
 * Watches the vault and emits debounced {@link VaultEvent} batches.
 *
 * - Uses one recursive `fs.watch` on the root when the platform supports it.
 * - Falls back to mtime polling when `fs.watch` throws or errors later, and
 *   keeps retrying the native watcher in the background.
 * - Never throws from a callback and never lets a listener error escape, so a
 *   misbehaving vault can not crash the server.
 */
export class VaultWatcher {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly listeners = new Set<(events: VaultEvent[]) => void>();
  private readonly pending = new Map<string, VaultEventType>();
  private known = new Map<string, number>();
  private watcher: fs.FSWatcher | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  constructor(root: string, options: VaultWatcherOptions = {}) {
    this.root = root;
    this.debounceMs = Math.max(10, options.debounceMs ?? 150);
    this.pollMs = Math.max(100, options.pollMs ?? 1000);
    this.onError = options.onError;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.syncKnown();
    this.startNative();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.pending.clear();
    this.listeners.clear();
  }

  /** Subscribe to event batches. Returns an unsubscribe function. */
  subscribe(listener: (events: VaultEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private syncKnown(): void {
    try {
      this.known = new Map([...scanVault(this.root)].map(([relativePath, file]) => [relativePath, file.mtime]));
    } catch (error) {
      this.report(error);
    }
  }

  private startNative(): void {
    if (this.stopped) return;
    if (this.watcher) return;
    try {
      const watcher = fs.watch(this.root, { recursive: true, persistent: true }, (eventType, filename) =>
        this.handleNative(eventType, filename),
      );
      watcher.on('error', (error) => this.degrade(error));
      this.watcher = watcher;
      this.stopPolling();
      if (this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (error) {
      this.degrade(error);
    }
  }

  /** Native watching failed: use polling and retry the watcher in the background. */
  private degrade(error: unknown): void {
    if (this.stopped) return;
    this.report(error);
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    this.startPolling();
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => {
        if (this.stopped || this.watcher) return;
        this.startNative();
      }, 5000);
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    if (this.stopped) return;
    try {
      const current = scanVault(this.root);
      const seen = new Set<string>();
      for (const [relativePath, file] of current) {
        seen.add(relativePath);
        const previous = this.known.get(relativePath);
        if (previous === undefined) this.queue(relativePath, 'add');
        else if (previous !== file.mtime) this.queue(relativePath, 'change');
      }
      for (const relativePath of this.known.keys()) {
        if (!seen.has(relativePath)) this.queue(relativePath, 'unlink');
      }
      this.known = new Map([...current].map(([relativePath, file]) => [relativePath, file.mtime]));
    } catch (error) {
      this.report(error);
    }
  }

  private handleNative(eventType: fs.WatchEventType, filename: string | Buffer | null): void {
    if (this.stopped) return;
    try {
      if (!filename) return;
      const relativePath = String(filename).split(path.sep).join('/');
      if (isIgnoredPath(relativePath)) return;
      const absolute = path.join(this.root, ...relativePath.split('/'));
      let exists = false;
      let mtime = 0;
      try {
        const stat = fs.statSync(absolute);
        exists = stat.isFile();
        mtime = stat.mtimeMs;
      } catch {
        exists = false;
      }
      if (!exists) {
        if (!this.known.has(relativePath)) return;
        this.known.delete(relativePath);
        this.queue(relativePath, 'unlink');
        return;
      }
      if (!isTextFileName(relativePath)) return;
      const previous = this.known.get(relativePath);
      if (previous === undefined) {
        this.known.set(relativePath, mtime);
        this.queue(relativePath, 'add');
      } else if (previous !== mtime) {
        this.known.set(relativePath, mtime);
        this.queue(relativePath, 'change');
      }
      // `eventType` is informational only: we derive add/change/unlink from
      // the filesystem so that rename (unlink + add) is reported correctly.
      void eventType;
    } catch (error) {
      this.report(error);
    }
  }

  private queue(relativePath: string, type: VaultEventType): void {
    const previous = this.pending.get(relativePath);
    if (previous === 'add' && type === 'unlink') {
      // Created and removed inside one debounce window: net no change.
      this.pending.delete(relativePath);
    } else if (previous === 'unlink' && type === 'add') {
      this.pending.set(relativePath, 'change');
    } else {
      this.pending.set(relativePath, type);
    }
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.stopped || this.pending.size === 0) return;
    const events: VaultEvent[] = [...this.pending].map(([relativePath, type]) => ({
      type,
      path: relativePath,
    }));
    this.pending.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(events);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    if (!this.onError) return;
    try {
      this.onError(error);
    } catch {
      // A broken logger must not break the watcher.
    }
  }
}

// ---------------------------------------------------------------------------
// Application home: config file + recent vaults + vault bootstrap helpers
// ---------------------------------------------------------------------------

/**
 * A vault reference as persisted on disk (a plain `RecentVault` without the
 * live `exists` flag).
 */
export interface StoredVaultRef {
  /** Canonical absolute path. */
  root: string;
  /** Folder name, shown in the switcher. */
  title: string;
  /** Epoch ms of the last time it was opened. */
  lastOpened: number;
}

/** Shape of `<home>/config.json`. Unknown keys are preserved on write. */
export interface AppConfig {
  recentVaults: StoredVaultRef[];
  lastVault: string | null;
  [key: string]: unknown;
}

/** How many recent vaults we keep around. */
export const MAX_RECENT_VAULTS = 12;

/** Resolve the app home directory (`TYPSIDIAN_HOME` or `~/.typsidian`). */
export function resolveAppHome(explicit?: string): string {
  const fromEnv = explicit ?? process.env.TYPSIDIAN_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.typsidian');
}

/** Canonical absolute path, resolving symlinks when the path exists. */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** True when `target` exists and is a directory. Never throws. */
export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function emptyConfig(): AppConfig {
  return { recentVaults: [], lastVault: null };
}

function normaliseStoredRef(value: unknown): StoredVaultRef | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.root !== 'string' || record.root.trim() === '') return null;
  const root = path.resolve(record.root);
  const title =
    typeof record.title === 'string' && record.title.trim() !== ''
      ? record.title
      : path.basename(root) || root;
  const lastOpened =
    typeof record.lastOpened === 'number' && Number.isFinite(record.lastOpened)
      ? record.lastOpened
      : 0;
  return { root, title, lastOpened };
}

/**
 * The app home directory and its `config.json`.
 *
 * Reads are tolerant: a missing, truncated or hand-edited config degrades to an
 * empty config instead of failing the request. Writes are atomic
 * (temporary file + rename) so a crash can never leave a half-written file.
 * Nothing here throws at startup, even when the home is read-only.
 */
export class AppHome {
  readonly dir: string;
  readonly configFile: string;
  private readonly warned = new Set<string>();

  constructor(dir?: string) {
    this.dir = path.resolve(dir ?? resolveAppHome());
    this.configFile = path.join(this.dir, 'config.json');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.warn(`cannot create app home ${this.dir}: ${messageOf(error)}`);
    }
  }

  /** Read the config, degrading to an empty config on any problem. */
  read(): AppConfig {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFile, 'utf8');
    } catch {
      return emptyConfig();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return emptyConfig();
      }
      const record = parsed as Record<string, unknown>;
      const recentVaults: StoredVaultRef[] = [];
      const seen = new Set<string>();
      if (Array.isArray(record.recentVaults)) {
        for (const entry of record.recentVaults) {
          const ref = normaliseStoredRef(entry);
          if (!ref) continue;
          if (seen.has(ref.root)) continue;
          seen.add(ref.root);
          recentVaults.push(ref);
          if (recentVaults.length >= MAX_RECENT_VAULTS) break;
        }
      }
      const lastVault =
        typeof record.lastVault === 'string' && record.lastVault.trim() !== ''
          ? path.resolve(record.lastVault)
          : null;
      return { ...record, recentVaults, lastVault };
    } catch {
      // Malformed JSON: keep the file for the user to inspect, start clean.
      this.warn(`config.json is malformed, ignoring it: ${this.configFile}`);
      return emptyConfig();
    }
  }

  /** Persist the config atomically. Returns false when the home is read-only. */
  write(config: AppConfig): boolean {
    const tmp = `${this.configFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ ...config, recentVaults: config.recentVaults.slice(0, MAX_RECENT_VAULTS) }, null, 2)}\n`,
        'utf8',
      );
      fs.renameSync(tmp, this.configFile);
      return true;
    } catch (error) {
      this.warn(`cannot write ${this.configFile}: ${messageOf(error)}`);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      return false;
    }
  }

  /** Stored recent vaults, newest first. */
  recentEntries(): StoredVaultRef[] {
    return this.read().recentVaults;
  }

  /** Recent vaults with their live `exists` flag, ready for the UI. */
  recentVaults(): RecentVault[] {
    return this.read().recentVaults.map((entry) => ({
      root: entry.root,
      title: entry.title,
      lastOpened: entry.lastOpened,
      exists: isDirectory(entry.root),
    }));
  }

  /** Remember an opened vault: de-duped, newest first, capped. */
  remember(root: string, title?: string): AppConfig {
    const canonical = canonicalPath(root);
    const config = this.read();
    const name = title?.trim() || path.basename(canonical) || canonical;
    config.recentVaults = [
      { root: canonical, title: name, lastOpened: Date.now() },
      ...config.recentVaults.filter((entry) => canonicalPath(entry.root) !== canonical),
    ].slice(0, MAX_RECENT_VAULTS);
    this.write(config);
    return config;
  }

  /** Record the vault that was opened last (persisted across restarts). */
  setLastVault(root: string | null): AppConfig {
    const config = this.read();
    config.lastVault = root ? canonicalPath(root) : null;
    this.write(config);
    return config;
  }

  /** Convenience: remember `root` and mark it as the last opened vault. */
  record(root: string, title?: string): void {
    this.remember(root, title);
    this.setLastVault(root);
  }

  /** Forget one vault (either from the recent list or as last vault). */
  removeRecent(root: string): AppConfig {
    const canonical = canonicalPath(root);
    const config = this.read();
    config.recentVaults = config.recentVaults.filter(
      (entry) => canonicalPath(entry.root) !== canonical,
    );
    if (config.lastVault && canonicalPath(config.lastVault) === canonical) {
      config.lastVault = null;
    }
    this.write(config);
    return config;
  }

  private warn(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.warn(`[typsidian] ${message}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Expand a leading `~` in a user supplied path. */
export function expandHome(target: string): string {
  const trimmed = target.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/** `mkdir -p` (including parents) and return the canonical directory path. */
export function ensureDirectory(target: string): string {
  const absolute = path.resolve(expandHome(target));
  fs.mkdirSync(absolute, { recursive: true });
  if (!isDirectory(absolute)) {
    throw new Error(`not a directory: ${absolute}`);
  }
  return canonicalPath(absolute);
}

/** Short starter document for a brand new vault. */
export function seedDocument(title: string): string {
  const heading = title.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  return `#set page(paper: "a4", margin: 2.5cm)
#set text(size: 11pt)

= ${heading || 'Welcome'}

This vault is a plain folder of \`.typ\` files — add notes from the sidebar, or
edit this file.

- \`⌥1\` Split mode: source and typeset pages side by side
- \`⌥2\` Visual mode: click a block and edit it in place
- \`⌥3\` Preview mode: read the finished document

#quote(block: true)[
  Type \`⌘S\` to save, \`⌘⇧E\` to export a PDF.
]
`;
}

/**
 * Seed `welcome.typ` when the vault has no editable documents yet.
 * Returns true when a file was written.
 */
export function seedEmptyVault(root: string): boolean {
  const vault = new Vault(root);
  if (vault.list().length > 0) return false;
  const title = path.basename(vault.root) || 'Welcome';
  fs.writeFileSync(path.join(vault.root, 'welcome.typ'), seedDocument(title), 'utf8');
  return true;
}

/** `base`, then `base 2`, `base 3`, ... — the first path that does not exist. */
export function uniqueDirectory(base: string): string {
  const absolute = path.resolve(expandHome(base));
  if (!fs.existsSync(absolute)) return absolute;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${absolute} ${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${absolute} ${Date.now().toString(36)}`;
}

/**
 * Create a vault directory (parents included) and seed it when empty.
 * Returns the canonical root of the new vault.
 */
export function createVaultDirectory(target: string): string {
  const root = ensureDirectory(target);
  seedEmptyVault(root);
  return root;
}

/** Recursively copy the bundled sample vault, skipping OS/editor junk. */
export function copySampleVault(source: string, destination: string): string {
  const root = ensureDirectory(source);
  const target = ensureDirectory(destination);
  fs.cpSync(root, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (entry) => {
      const name = path.basename(entry);
      if (IGNORED_DIRECTORIES.has(name)) return false;
      if (name === '.DS_Store' || name.startsWith('.') && name !== '.') {
        // Skip hidden OS files, but never skip the destination itself: the
        // filter only ever sees entries inside `root`.
        return false;
      }
      if (IGNORED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
      return true;
    },
  });
  return target;
}
