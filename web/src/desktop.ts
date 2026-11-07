/**
 * Desktop shell bridge.
 *
 * Inside the Electron app the preload script exposes `window.typsidian`; in a
 * plain browser everything degrades gracefully (the welcome screen offers a
 * typed path instead of a native folder dialog).
 */

import type { DesktopBridge } from './contracts';

declare global {
  interface Window {
    typsidian?: DesktopBridge;
    /** Commands the Electron application menu invokes on the renderer. */
    __typsidianMenu?: {
      openVault(path: string): void;
      newVault(): void;
      closeVault(): void;
      exportPdf(): void;
      newNote(): void;
      toggleSidebar(): void;
    };
  }
}

export const desktop: DesktopBridge | null =
  typeof window !== 'undefined' && window.typsidian?.isDesktop ? window.typsidian : null;

export const isDesktop = desktop !== null;

/** Mark the document so shell CSS can make room for the hidden title bar. */
export function applyDesktopChrome(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.desktop = desktop
    ? desktop.platform === 'darwin'
      ? 'mac'
      : 'desktop'
    : 'web';
}
