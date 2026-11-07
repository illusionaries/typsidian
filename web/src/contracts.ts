/**
 * Component contracts between the app shell and the three editing surfaces.
 *
 * Every surface is language agnostic: it receives blocks, boxes, diagnostics
 * and splices — never Typst-specific data.
 */

import type {
  BlockAction,
  DocBlock,
  OutlineItem,
  RenderDiagnostic,
  RenderResult,
  SourceRange,
} from '../../shared/doc';
import type { FileEntry, RecentVault, WorkspaceInfo } from '../../shared/protocol';

export type ViewMode = 'split' | 'visual' | 'preview';

/** A request to move the editor caret to a range (jump-to-source). */
export interface RevealRequest {
  range: SourceRange;
  /** Increase to re-trigger even for an identical range. */
  nonce: number;
  /** Select the whole range instead of collapsing the caret at the start. */
  select?: boolean;
}

export interface EditorPaneProps {
  /** Workspace-relative path of the open document. */
  path: string;
  /** Current source (controlled). */
  source: string;
  /** Language id, e.g. "typst". */
  language: string;
  /** Diagnostics to underline. */
  diagnostics: RenderDiagnostic[];
  /** Caret jump requests coming from the preview. */
  reveal: RevealRequest | null;
  /** Per-block actions to expose in the context menu / shortcut palette. */
  blockActions(block: DocBlock): BlockAction[];
  onChange(source: string): void;
  onSave(): void;
  /** Caret / selection changed, in source offsets. */
  onCursor(cursor: { offset: number; from: number; to: number }): void;
  /** Topmost visible source range, used for preview sync scrolling. */
  onVisibleRange(range: SourceRange): void;
  /** The block containing the caret, if any. */
  onActiveBlock(block: DocBlock | null): void;
}

export interface PreviewSurfaceProps {
  render: RenderResult | null;
  /** Current source; the inline editor needs it to compute splices. */
  source: string;
  language: string;
  mode: ViewMode;
  zoom: number;
  pending: boolean;
  error: string | null;
  /** Block highlighted because the caret is inside it. */
  activeBlockId: string | null;
  /** Block the surface must scroll into view. */
  revealBlockId: string | null;
  /** Block currently open in the inline editor (visual mode). */
  editingBlockId: string | null;
  /** Ask the shell to open/close the inline editor for a block. */
  onRequestEdit(blockId: string | null): void;
  /** Block was clicked in split/preview mode: jump to source. */
  onActivateBlock(block: DocBlock): void;
  /** Run one of the block actions (bold, heading level, ...). */
  onRunBlockAction(blockId: string, actionId: string): void;
  /** Live text update while inline editing. */
  onEditBlockText(blockId: string, text: string): void;
  /** Commit the inline edit (blur / Esc / Cmd+Enter). */
  onCommitEdit(): void;
  onZoom(zoom: number): void;
  /** Topmost visible block, used to sync the source editor scroll. */
  onVisibleBlock(blockId: string | null): void;
}

export interface FileTreeProps {
  workspace: WorkspaceInfo | null;
  activePath: string | null;
  /** Paths with unsaved changes. */
  dirtyPaths: string[];
  onOpen(path: string): void;
  onCreateFile(path: string): Promise<void> | void;
  onRename(from: string, to: string): Promise<void> | void;
  onDelete(path: string): Promise<void> | void;
  onRefresh(): void;
  /** Collapse the sidebar (mobile / focus mode). */
  onClose?(): void;
}

export interface OutlineProps {
  outline: OutlineItem[];
  activeBlockId: string | null;
  onJump(item: OutlineItem): void;
  onClose?(): void;
}

export interface TabStripProps {
  tabs: Array<{ path: string; title: string; dirty: boolean }>;
  activePath: string | null;
  onSelect(path: string): void;
  onClose(path: string): void;
}

export interface StatusBarProps {
  path: string | null;
  language: string;
  cursor: { line: number; column: number };
  pageCount: number;
  blockCount: number;
  renderMs: number;
  pending: boolean;
  diagnostics: RenderDiagnostic[];
  mode: ViewMode;
  wordCount: number;
  onToggleDiagnostics(): void;
}

export interface FilesSnapshot {
  files: FileEntry[];
}

// ---------------------------------------------------------------------------
// Vault management surfaces (standalone app)
// ---------------------------------------------------------------------------

export interface WelcomeScreenProps {
  recent: RecentVault[];
  version: string;
  home: string;
  /** True inside the Electron shell, where native folder dialogs exist. */
  desktop: boolean;
  busy: boolean;
  error: string | null;
  sampleAvailable: boolean;
  onOpenRecent(path: string): void;
  /** Open a folder: native dialog in the desktop app, inline path input in a browser. */
  onChooseFolder(): void;
  onCreateVault(): void;
  onOpenSample(): void;
  onRemoveRecent(path: string): void;
  /** Fallback for browser/dev: open an absolute path typed by the user. */
  onOpenPath(path: string): void;
}

export interface VaultSwitcherProps {
  title: string;
  root: string | null;
  recent: RecentVault[];
  desktop: boolean;
  busy: boolean;
  onOpen(path: string): void;
  onChoose(): void;
  onCreate(): void;
  onReveal(): void;
  /** Close the vault and go back to the welcome screen. */
  onCloseVault(): void;
  onRemoveRecent(path: string): void;
}

/** Shape of the preload bridge exposed by the Electron shell. */
export interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  readonly appVersion: string;
  /** Native folder picker for opening a vault; null when cancelled. */
  chooseVaultFolder(): Promise<string | null>;
  /** Native picker for the parent directory of a new vault; null when cancelled. */
  chooseNewVaultParent(): Promise<string | null>;
  /** Select a vault folder in Finder. */
  revealVault(path: string): void;
  openExternal(url: string): void;
  /** Restart the app (used by the "reload" affordance on failure). */
  reload(): void;
}
