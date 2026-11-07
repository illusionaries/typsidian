/**
 * Sidebar surface: the vault file tree, the document outline and the live
 * vault-change hook. The app shell renders these inside its own sidebar chrome
 * (`<FileTree />`, `<OutlinePanel />`) and may subscribe to external edits with
 * `useVaultEvents(...)`.
 */

export { FileTree } from './FileTree';
export { VaultSwitcher } from './VaultSwitcher';
export { OutlinePanel } from './OutlinePanel';
export { useVaultEvents } from './useVaultEvents';
export type {
  UseVaultEventsOptions,
  VaultEvent,
  VaultEventType,
  VaultEventsState,
} from './useVaultEvents';

export type { TreeOverlay, TreeRow } from './tree';
