/**
 * Application state.
 *
 * A tiny external store (no framework dependency) so the three editing
 * surfaces stay in sync without prop drilling. All language-specific behaviour
 * goes through `getLanguageClient`, all compilation through the server API —
 * the store itself only knows about blocks, splices and renders.
 */

import { useSyncExternalStore } from 'react';

import {
  applySplice,
  blockAtOffset,
  lineColumn,
  type BlockAction,
  type DocBlock,
  type RenderResult,
  type SourceRange,
} from '../../shared/doc';
import type { FileEntry, WorkspaceInfo } from '../../shared/protocol';
import { api, ApiError } from './api';
import type { RevealRequest, ViewMode } from './contracts';
import { getLanguageClient } from './languages';

export interface OpenTab {
  path: string;
  source: string;
  savedSource: string;
  /** Source offsets. */
  cursor: { offset: number; from: number; to: number };
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface AppState {
  ready: boolean;
  fatalError: string | null;
  mode: ViewMode;
  theme: 'dark' | 'light';
  sidebarOpen: boolean;
  sidebarTab: 'files' | 'outline';
  workspace: WorkspaceInfo | null;
  tabs: OpenTab[];
  activePath: string | null;
  renders: Record<string, RenderResult | null>;
  renderError: string | null;
  pending: boolean;
  saving: boolean;
  activeBlockId: string | null;
  reveal: RevealRequest | null;
  /** Block the preview should scroll to (driven by the source editor). */
  revealBlockId: string | null;
  /** Block open in the visual inline editor. */
  editingBlockId: string | null;
  zoom: number;
  diagnosticsOpen: boolean;
  toasts: Toast[];
}

type Listener = () => void;

const RENDER_DEBOUNCE_MS = 140;
const AUTOSAVE_DEBOUNCE_MS = 900;

function tabOf(state: AppState): OpenTab | null {
  return state.tabs.find((tab) => tab.path === state.activePath) ?? null;
}

function languageForPath(path: string | null, workspace: WorkspaceInfo | null): string {
  if (!path) return 'plain';
  const lower = path.toLowerCase();
  const languages = workspace?.languages ?? [];
  for (const language of languages) {
    if (language.extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
      return language.id;
    }
  }
  return 'plain';
}

const UI_STORAGE_KEY = 'typsidian.ui';

interface PersistedUi {
  theme?: 'dark' | 'light';
  zoom?: number;
  sidebarOpen?: boolean;
  mode?: ViewMode;
}

function loadPersistedUi(): PersistedUi {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedUi;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

class Store {
  private state: AppState = {
    ready: false,
    fatalError: null,
    mode: 'split',
    theme: 'dark',
    sidebarOpen: true,
    sidebarTab: 'files',
    workspace: null,
    tabs: [],
    activePath: null,
    renders: {},
    renderError: null,
    pending: false,
    saving: false,
    activeBlockId: null,
    reveal: null,
    revealBlockId: null,
    editingBlockId: null,
    zoom: 1,
    diagnosticsOpen: false,
    toasts: [],
  };

  constructor() {
    const persisted = loadPersistedUi();
    this.state = {
      ...this.state,
      theme: persisted.theme === 'light' ? 'light' : 'dark',
      zoom: typeof persisted.zoom === 'number' ? persisted.zoom : 1,
      sidebarOpen: persisted.sidebarOpen !== false,
      mode: persisted.mode === 'visual' || persisted.mode === 'preview' ? persisted.mode : 'split',
    };
  }

  private persistUi(): void {
    try {
      localStorage.setItem(
        UI_STORAGE_KEY,
        JSON.stringify({
          theme: this.state.theme,
          zoom: this.state.zoom,
          sidebarOpen: this.state.sidebarOpen,
          mode: this.state.mode,
        }),
      );
    } catch {
      /* storage may be unavailable */
    }
  }

  private listeners = new Set<Listener>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private renderSeq = 0;
  private toastSeq = 0;
  /**
   * Visual-mode edit session. While a block is open in the inline editor we
   * track ITS range in the *current* source, because the last server render
   * describes an older source revision. Splicing against stale block ranges
   * duplicates text.
   */
  private editSession: { blockId: string; block: DocBlock } | null = null;
  /** Incremented for every source mutation; used to reject stale renders. */
  private sourceVersion = 0;
  private revealSeq = 0;
  private dragging = false;
  private initPromise: Promise<void> | null = null;
  private opening = new Set<string>();

  // ------------------------------------------------------------- plumbing --

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  private set(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    this.persistUi();
    for (const listener of this.listeners) listener();
  }

  get activeTab(): OpenTab | null {
    return tabOf(this.state);
  }

  get render(): RenderResult | null {
    const path = this.state.activePath;
    return path ? this.state.renders[path] ?? null : null;
  }

  get language(): string {
    return languageForPath(this.state.activePath, this.state.workspace);
  }

  // --------------------------------------------------------------- boot ----

  /** Boot once, even under React StrictMode's double effects. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const workspace = await api.workspace();
      const preferred =
        workspace.files.find((file) => file.path === 'welcome.typ') ??
        workspace.files.find((file) => file.language === 'typst') ??
        workspace.files[0] ??
        null;
      this.set({ workspace, ready: true });
      if (preferred) await this.openFile(preferred.path);
      else this.set({ mode: 'preview' });
    } catch (error) {
      this.set({
        ready: true,
        fatalError:
          error instanceof Error
            ? `${error.message}\n\nIs the local server running? Start it with: npm run dev`
            : String(error),
      });
    }
  }

  async refreshWorkspace(): Promise<WorkspaceInfo | null> {
    try {
      const workspace = await api.workspace();
      this.set({ workspace });
      return workspace;
    } catch {
      return null;
    }
  }

  /** React to file-system changes coming from the vault watcher. */
  async handleVaultEvents(events: Array<{ type: 'change' | 'add' | 'unlink'; path: string }>): Promise<void> {
    if (events.length === 0) return;
    let needsRefresh = false;
    for (const event of events) {
      const tab = this.state.tabs.find((candidate) => candidate.path === event.path);
      const active = this.state.activePath === event.path;
      if (event.type === 'unlink') {
        if (!tab) {
          needsRefresh = true;
          continue;
        }
        if (tab.source === tab.savedSource) this.closeTab(event.path);
        needsRefresh = true;
        continue;
      }
      if (event.type === 'change' && tab && tab.source === tab.savedSource) {
        try {
          const file = await api.readFile(event.path);
          if (file.source !== tab.source) {
            this.set((state) => ({
              tabs: state.tabs.map((candidate) =>
                candidate.path === event.path
                  ? { ...candidate, source: file.source, savedSource: file.source }
                  : candidate,
              ),
            }));
            if (active) this.scheduleRender(0);
          }
        } catch {
          /* file vanished mid-read; the next event will settle it */
        }
      }
      needsRefresh = true;
    }
    if (needsRefresh) void this.refreshWorkspace();
  }

  fileEntry(path: string | null): FileEntry | null {
    if (!path) return null;
    return this.state.workspace?.files.find((file) => file.path === path) ?? null;
  }

  // -------------------------------------------------------------- files ----

  async openFile(path: string): Promise<void> {
    if (this.opening.has(path)) return;
    const existing = this.state.tabs.find((tab) => tab.path === path);
    if (existing) {
      this.set({ activePath: path, editingBlockId: null, revealBlockId: null });
      this.endEditSession();
      if (!this.state.renders[path]) this.scheduleRender(0);
      return;
    }
    this.opening.add(path);
    try {
      const file = await api.readFile(path);
      const tab: OpenTab = {
        path: file.path,
        source: file.source,
        savedSource: file.source,
        cursor: { offset: 0, from: 0, to: 0 },
      };
      this.set((state) => ({
        tabs: [...state.tabs, tab],
        activePath: file.path,
        editingBlockId: null,
        revealBlockId: null,
      }));
      document.title = `${file.path.split('/').pop()} — Typsidian`;
      this.endEditSession();
      await this.renderNow();
    } catch (error) {
      this.toast(`Could not open ${path}: ${messageOf(error)}`, 'error');
    } finally {
      this.opening.delete(path);
    }
  }

  closeTab(path: string): void {
    const index = this.state.tabs.findIndex((tab) => tab.path === path);
    if (index < 0) return;
    const tab = this.state.tabs[index];
    if (tab.source !== tab.savedSource) {
      void this.saveTab(tab);
    }
    const tabs = this.state.tabs.filter((candidate) => candidate.path !== path);
    const nextActive =
      this.state.activePath === path
        ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null
        : this.state.activePath;
    this.set({ tabs, activePath: nextActive, editingBlockId: null });
    this.endEditSession();
    if (nextActive && !this.state.renders[nextActive]) this.scheduleRender(0);
  }

  async createFile(path: string): Promise<void> {
    try {
      await api.createFile(path, `= ${titleOf(path)}\n\n`);
      await this.refreshWorkspace();
      await this.openFile(path);
      this.toast(`Created ${path}`, 'success');
    } catch (error) {
      this.toast(`Could not create ${path}: ${messageOf(error)}`, 'error');
      throw error;
    }
  }

  async renameFile(from: string, to: string): Promise<void> {
    try {
      await api.renameFile(from, to);
      const tabs = this.state.tabs.map((tab) =>
        tab.path === from ? { ...tab, path: to } : tab,
      );
      const renders = { ...this.state.renders };
      if (renders[from] !== undefined) {
        renders[to] = renders[from];
        delete renders[from];
      }
      this.set({
        tabs,
        renders,
        activePath: this.state.activePath === from ? to : this.state.activePath,
      });
      await this.refreshWorkspace();
      this.toast(`Renamed to ${to}`, 'success');
    } catch (error) {
      this.toast(`Rename failed: ${messageOf(error)}`, 'error');
      throw error;
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await api.deleteFile(path);
      const tabs = this.state.tabs.filter((tab) => tab.path !== path);
      const renders = { ...this.state.renders };
      delete renders[path];
      this.set({
        tabs,
        renders,
        activePath: this.state.activePath === path ? tabs[0]?.path ?? null : this.state.activePath,
      });
      await this.refreshWorkspace();
      this.toast(`Deleted ${path}`, 'success');
    } catch (error) {
      this.toast(`Delete failed: ${messageOf(error)}`, 'error');
      throw error;
    }
  }

  // ------------------------------------------------------------ editing ----

  setSource(source: string): void {
    const tab = this.activeTab;
    if (!tab || source === tab.source) return;
    this.sourceVersion++;
    const tabs = this.state.tabs.map((candidate) =>
      candidate.path === tab.path ? { ...candidate, source } : candidate,
    );
    this.set({ tabs });
    this.scheduleRender();
    this.scheduleAutosave();
  }

  setCursor(cursor: { offset: number; from: number; to: number }): void {
    const tab = this.activeTab;
    if (!tab) return;
    const tabs = this.state.tabs.map((candidate) =>
      candidate.path === tab.path ? { ...candidate, cursor } : candidate,
    );
    const render = this.render;
    const block = render ? blockAtOffset(render.blocks, cursor.offset) : null;
    const patch: Partial<AppState> = { tabs };
    if (block && block.id !== this.state.activeBlockId) {
      patch.activeBlockId = block.id;
      patch.revealBlockId = block.id;
    } else if (!block && this.state.activeBlockId) {
      patch.activeBlockId = null;
    }
    this.set(patch);
  }

  setReveal(range: SourceRange, select = false): void {
    this.set({ reveal: { range, nonce: ++this.revealSeq, select } });
  }

  /** Editor viewport changed: keep the preview roughly in sync. */
  setVisibleRange(range: SourceRange): void {
    const render = this.render;
    if (!render || this.state.mode !== 'split') return;
    const block = blockAtOffset(render.blocks, range.from);
    if (block && block.id !== this.state.revealBlockId) {
      this.set({ revealBlockId: block.id });
    }
  }

  setActiveBlockId(blockId: string | null): void {
    if (blockId !== this.state.activeBlockId) this.set({ activeBlockId: blockId });
  }

  // ------------------------------------------------------- visual editing --

  requestEdit(blockId: string | null): void {
    if (blockId === null) {
      this.cancelEdit();
      return;
    }
    const block = this.renderBlock(blockId);
    if (!block) return;
    this.editSession = { blockId, block };
    this.set({ editingBlockId: blockId, mode: 'visual' });
  }

  cancelEdit(): void {
    this.endEditSession();
    this.set({ editingBlockId: null });
  }

  private endEditSession(): void {
    this.editSession = null;
    if (this.state.editingBlockId) this.set({ editingBlockId: null });
  }

  /** Text of a block changed by the inline editor. */
  editBlockText(blockId: string, text: string): void {
    const tab = this.activeTab;
    if (!tab) return;
    const session = this.editSession && this.editSession.blockId === blockId ? this.editSession : null;
    const block = session ? session.block : this.renderBlock(blockId);
    if (!block) return;
    const client = getLanguageClient(this.language);
    const splice = client.spliceBlockEdit(tab.source, block, text);
    if (splice.from === splice.to && splice.insert === '') return;

    // Keep the edit session's range in sync with the source we are producing.
    if (session) {
      const range = session.block.range;
      const delta = splice.insert.length - (splice.to - splice.from);
      if (splice.from >= range.from && splice.to <= range.to) {
        session.block = {
          ...session.block,
          text,
          range: { from: range.from, to: Math.max(range.from, range.to + delta) },
        };
      } else if (splice.from <= range.from && splice.to >= range.to) {
        session.block = {
          ...session.block,
          text,
          range: { from: splice.from, to: splice.from + splice.insert.length },
        };
      } else {
        session.block = {
          ...session.block,
          text,
          range: {
            from: Math.min(range.from, splice.from),
            to: Math.max(range.to + delta, splice.from + splice.insert.length),
          },
        };
      }
    }

    this.setSource(applySplice(tab.source, splice));
    if (!this.state.editingBlockId) this.set({ editingBlockId: blockId });
  }

  runBlockAction(blockId: string, actionId: string): void {
    const tab = this.activeTab;
    const block = this.renderBlock(blockId);
    if (!tab || !block) return;
    const action = this.blockActions(block).find((candidate) => candidate.id === actionId);
    if (!action) return;
    const splice = action.run(tab.source, block);
    if (!splice) return;
    this.setSource(applySplice(tab.source, splice));
  }

  blockActions(block: DocBlock): BlockAction[] {
    const tab = this.activeTab;
    if (!tab) return [];
    return getLanguageClient(this.language).actions(tab.source, block);
  }

  editableText(block: DocBlock): string {
    const tab = this.activeTab;
    if (!tab) return block.text;
    return getLanguageClient(this.language).editableText(tab.source, block);
  }

  renderBlock(blockId: string | null): DocBlock | null {
    if (!blockId) return null;
    return this.render?.blocks.find((block) => block.id === blockId) ?? null;
  }

  // --------------------------------------------------------------- modes ---

  setMode(mode: ViewMode): void {
    if (mode !== 'visual') this.endEditSession();
    this.set({ mode, editingBlockId: mode === 'visual' ? this.state.editingBlockId : null });
  }

  toggleSidebar(): void {
    this.set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  }

  setSidebarTab(tab: 'files' | 'outline'): void {
    this.set({ sidebarTab: tab, sidebarOpen: true });
  }

  setTheme(theme: 'dark' | 'light'): void {
    document.documentElement.dataset.theme = theme;
    this.set({ theme });
  }

  toggleTheme(): void {
    this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark');
  }

  setZoom(zoom: number): void {
    this.set({ zoom: Math.min(3, Math.max(0.4, Math.round(zoom * 100) / 100)) });
  }

  toggleDiagnostics(): void {
    this.set((state) => ({ diagnosticsOpen: !state.diagnosticsOpen }));
  }

  // ------------------------------------------------------------- render ----

  scheduleRender(delay = RENDER_DEBOUNCE_MS): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.renderNow();
    }, delay);
  }

  async renderNow(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    const path = tab.path;
    const source = tab.source;
    const language = languageForPath(path, this.state.workspace);
    if (language === 'plain') {
      this.set({ renderError: null, pending: false });
      return;
    }
    const seq = ++this.renderSeq;
    const requestVersion = this.sourceVersion;
    this.set({ pending: true });
    try {
      // Send every unsaved buffer so `#import "sibling.typ"` sees live edits.
      const files: Record<string, string> = {};
      for (const candidate of this.state.tabs) {
        if (candidate.path !== path && candidate.source !== candidate.savedSource) {
          files[candidate.path] = candidate.source;
        }
      }
      const result = await api.render({ path, source, files });
      if (seq !== this.renderSeq) return;
      // A failed compile has no pages. Keep showing the last good typeset page
      // (with the new diagnostics on top) instead of flashing an empty pane.
      const previous = this.state.renders[path] ?? null;
      const merged =
        result.pages.length === 0 && previous && previous.pages.length > 0
          ? {
              ...result,
              pages: previous.pages,
              boxes: previous.boxes,
              outline: result.outline.length > 0 ? result.outline : previous.outline,
            }
          : result;
      const renders = { ...this.state.renders, [path]: merged };
      const patch: Partial<AppState> = {
        renders: { ...this.state.renders, [path]: merged },
        renderError: null,
        pending: false,
      };
      // If no keystroke landed while this render was in flight, its block
      // ranges are authoritative: rebase the visual edit session onto them.
      if (this.editSession && requestVersion === this.sourceVersion) {
        const fresh = merged.blocks.find((block) => block.id === this.editSession?.blockId) ?? null;
        if (fresh) {
          this.editSession = {
            blockId: fresh.id,
            block: { ...fresh, text: this.editSession.block.text },
          };
        }
      }
      const cursor = this.activeTab?.cursor;
      if (cursor) {
        const block = blockAtOffset(merged.blocks, cursor.offset);
        patch.activeBlockId = block ? block.id : null;
      }
      this.set(patch);
    } catch (error) {
      if (seq !== this.renderSeq) return;
      this.set({ pending: false, renderError: messageOf(error) });
    }
  }

  // -------------------------------------------------------------- saving ---

  scheduleAutosave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    await this.saveTab(tab);
  }

  private async saveTab(tab: OpenTab): Promise<void> {
    if (tab.source === tab.savedSource) return;
    this.set({ saving: true });
    try {
      await api.writeFile(tab.path, tab.source);
      this.set((state) => ({
        saving: false,
        tabs: state.tabs.map((candidate) =>
          candidate.path === tab.path
            ? { ...candidate, savedSource: tab.source }
            : candidate,
        ),
      }));
      void this.refreshWorkspace();
    } catch (error) {
      this.set({ saving: false });
      this.toast(`Autosave failed: ${messageOf(error)}`, 'error');
    }
  }

  async exportPdf(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    try {
      const files: Record<string, string> = {};
      for (const candidate of this.state.tabs) {
        if (candidate.path !== tab.path && candidate.source !== candidate.savedSource) {
          files[candidate.path] = candidate.source;
        }
      }
      const blob = await api.exportPdf({ path: tab.path, source: tab.source, files });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${tab.path.replace(/\.[^.]+$/, '')}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.toast('Exported PDF', 'success');
    } catch (error) {
      this.toast(`Export failed: ${messageOf(error)}`, 'error');
    }
  }

  // --------------------------------------------------------------- misc ----

  toast(text: string, kind: Toast['kind'] = 'info'): void {
    const toast: Toast = { id: ++this.toastSeq, kind, text };
    this.set((state) => ({ toasts: [...state.toasts, toast] }));
    setTimeout(() => {
      this.set((state) => ({ toasts: state.toasts.filter((candidate) => candidate.id !== toast.id) }));
    }, kind === 'error' ? 6000 : 3000);
  }

  dismissToast(id: number): void {
    this.set((state) => ({ toasts: state.toasts.filter((candidate) => candidate.id !== id) }));
  }

  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return;
    this.dragging = dragging;
    document.body.classList.toggle('app--dragging', dragging);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  // ------------------------------------------------------ derived helpers --

  get dirtyPaths(): string[] {
    return this.state.tabs
      .filter((tab) => tab.source !== tab.savedSource)
      .map((tab) => tab.path);
  }

  get wordCount(): number {
    const tab = this.activeTab;
    if (!tab) return 0;
    return tab.source.trim() ? tab.source.trim().split(/\s+/).length : 0;
  }

  get cursorPosition(): { line: number; column: number; offset: number } {
    const tab = this.activeTab;
    if (!tab) return { line: 1, column: 1, offset: 0 };
    const { line, column } = lineColumn(tab.source, tab.cursor.offset);
    return { line, column, offset: tab.cursor.offset };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function titleOf(path: string): string {
  return (
    path
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase()) ?? 'Untitled'
  );
}

export const store = new Store();

/** React binding. */
export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
