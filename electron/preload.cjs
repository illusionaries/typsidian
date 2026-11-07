/**
 * Typsidian desktop preload — the only bridge between the Electron shell and
 * the renderer.
 *
 * It exposes exactly the `DesktopBridge` shape declared in
 * web/src/contracts.ts, so the React app can use native folder pickers,
 * "reveal in Finder", external links and reload without knowing about IPC.
 * Everything else stays in the renderer: application-menu commands are routed
 * by the main process to `window.__typsidianMenu` (web/src/store.ts).
 *
 * Runs with `contextIsolation: true` and `sandbox: false` (see main.cjs).
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Version read synchronously from the main process before the page boots. */
function appVersion() {
  try {
    return String(ipcRenderer.sendSync('app:version') ?? '0.0.0');
  } catch {
    // sendSync throws if the main process has no handler (e.g. during reload).
    return '0.0.0';
  }
}

const platform = process.platform;

/** @type {import('../web/src/contracts').DesktopBridge} */
const bridge = {
  isDesktop: true,
  platform,
  appVersion: appVersion(),

  /** Native folder picker for opening a vault; null when cancelled. */
  chooseVaultFolder: () => ipcRenderer.invoke('vault:choose-folder'),

  /** Native picker for the parent directory of a new vault; null when cancelled. */
  chooseNewVaultParent: () => ipcRenderer.invoke('vault:choose-new-parent'),

  /** Select the vault folder in Finder. */
  revealVault: (vaultPath) => {
    const target = typeof vaultPath === 'string' ? vaultPath : '';
    void ipcRenderer.invoke('vault:reveal', target);
  },

  /** Open an http(s) URL in the user's browser (other schemes are ignored). */
  openExternal: (url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void ipcRenderer.invoke('shell:open-external', url);
    }
  },

  /** Reload the renderer (the "try again" affordance when the app gets stuck). */
  reload: () => {
    ipcRenderer.send('app:reload');
  },
};

contextBridge.exposeInMainWorld('typsidian', bridge);
