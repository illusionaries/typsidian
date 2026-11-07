/**
 * Typsidian desktop shell — Electron main process.
 *
 * Two processes:
 *
 *   Electron (this file)              express server (dist-server/index.cjs)
 *   ────────────────────────          ─────────────────────────────────────
 *   native window, macOS menus   ───▶ serves the built web app (dist/) and the
 *   folder pickers, IPC bridge        JSON API on its own loopback port, with
 *                                     the typst compiler (native addon).
 *
 * The server is forked with `ELECTRON_RUN_AS_NODE=1`, so Electron's own Node
 * runtime is the only one the packaged app needs. The port is picked at launch
 * (a free port on 127.0.0.1) and becomes the window origin, keeping the
 * renderer an ordinary web app that talks to same-origin `/api`.
 *
 * Menu commands are "user intent", not data flow: they call the renderer's
 * `window.__typsidianMenu` API (defined in web/src/store.ts) via
 * `executeJavaScript`. The preload only exposes the small DesktopBridge from
 * web/src/contracts.ts (folder pickers, reveal, external links, reload).
 *
 * Plain CommonJS on purpose: Electron 33 runs this file directly, no build step.
 */

'use strict';

const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');

const APP_NAME = 'Typsidian';
const HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 150;
const RECENT_LIMIT = 8;

// ---------------------------------------------------------------------------
// Boot log
// ---------------------------------------------------------------------------
//
// A packaged app launched from Finder has no terminal, so the first thing the
// shell does is append to ~/Library/Logs/Typsidian/main.log. That makes a launch
// that dies before the window appears debuggable instead of silent.

const BOOT_LOG = (() => {
  const dir = path.join(require('node:os').homedir(), 'Library', 'Logs', APP_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'main.log');
  } catch {
    return null;
  }
})();

function bootLog(message) {
  const line = `[${new Date().toISOString()}] [${process.pid}] ${message}\n`;
  if (!BOOT_LOG) return;
  try {
    fs.appendFileSync(BOOT_LOG, line);
  } catch {
    // never let logging break the app
  }
}

process.on('uncaughtException', (error) => {
  bootLog(`uncaught exception: ${error?.stack ?? error}`);
  console.error(error);
  if (!quitting) failFatal(error);
});
process.on('unhandledRejection', (reason) => {
  bootLog(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

bootLog(`main.cjs loaded (electron ${process.versions.electron}, argv=${process.argv.slice(1).join(' ')})`);

app.setName(APP_NAME);
if (process.platform === 'darwin' && app.setAboutPanelOptions) {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'An Obsidian-like editor for Typst.',
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
let serverPort = 0;
/** Set once the app is quitting so crash/exit handlers stay quiet. */
let quitting = false;
let serverLogStream = null;
let menuRebuildTimer = null;
let lastRecentVaults = [];

if (!app.requestSingleInstanceLock()) {
  bootLog('another instance already owns the lock: quitting');
  app.quit();
} else {
  bootLog('single instance lock acquired');
  boot();
}

function boot() {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Native chrome follows the *app* theme, not the system theme. macOS draws the
  // traffic lights for the window's effective appearance: a dark app window in
  // light system mode otherwise gets the dim light-mode buttons, which don't
  // match the dark background (same issue as VS Code). The renderer keeps this
  // in sync through the preload bridge ('theme:sync'); dark is the app default.
  nativeTheme.themeSource = 'dark';

  app.whenReady().then(onReady).catch(failFatal);

  // A document app: closing the last window quits, on macOS too.
  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    // Dock click after the window was closed: bring it back.
    if (!mainWindow && !quitting && serverPort) {
      void createWindow(serverPort).catch(failFatal);
    }
  });

  app.on('before-quit', () => {
    bootLog('before-quit');
    quitting = true;
    stopServer();
  });
  app.on('will-quit', () => {
    quitting = true;
    stopServer();
  });

  app.on('web-contents-created', (_event, contents) => {
    // Never navigate the shell window away from the local app.
    contents.on('will-navigate', (event, url) => {
      if (serverPort && url.startsWith(`http://${HOST}:${serverPort}/`)) return;
      if (process.env.TYPSIDIAN_DEV_URL && url.startsWith(process.env.TYPSIDIAN_DEV_URL)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
  });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function repoRoot() {
  return path.resolve(__dirname, '..');
}

/** The bundled server entry (inside app.asar when packaged). */
function serverEntry() {
  return app.isPackaged
    ? path.join(app.getAppPath(), 'dist-server', 'index.cjs')
    : path.join(repoRoot(), 'dist-server', 'index.cjs');
}

/** Bundled sample vault (extraResources → Contents/Resources/sample-vault). */
function sampleVaultDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sample-vault')
    : path.join(repoRoot(), 'sample-vault');
}

/** Optional native typst-syntax parser helper (falls back to the TS splitter). */
function nativeParserBinary() {
  const name = process.platform === 'win32' ? 'typsidian-parser.exe' : 'typsidian-parser';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', name)]
    : [
        path.join(repoRoot(), 'native', 'target', 'release', name),
        path.join(repoRoot(), 'native', 'target', 'debug', name),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function userDataDir() {
  return app.getPath('userData');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function onReady() {
  bootLog('app ready: starting the local server');
  registerIpc();
  const port = await findFreePort();
  await startServer(port);
  serverPort = port;
  bootLog(`server ready on ${HOST}:${port}`);
  await createWindow(port);
  await rebuildMenu();
  bootLog('window shown');
}

/** Ask the kernel for an unused loopback port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

function startServer(port) {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`Server bundle missing at ${entry}\nRun: bun run build:server`);
  }

  const home = userDataDir();
  fs.mkdirSync(home, { recursive: true });

  // Server logs: prefixed on the console + appended to userData/logs/server.log
  // (a packaged app launched from Finder leaves a trace there).
  const logDir = path.join(home, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  serverLogStream = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TYPSIDIAN_PORT: String(port),
    TYPSIDIAN_HOST: HOST,
    TYPSIDIAN_HOME: home,
    TYPSIDIAN_SAMPLE_VAULT: sampleVaultDir(),
    // No TYPSIDIAN_VAULT on purpose: the app boots to the welcome screen.
  };
  delete env.TYPSIDIAN_VAULT;
  const parser = nativeParserBinary();
  if (parser) env.TYPSIDIAN_TYPST_PARSER = parser;

  console.log(`[typsidian] server ${entry} (port ${port})`);
  const child = fork(entry, [], {
    env,
    cwd: home,
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serverProcess = child;

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) writeServerLog(line);
    });
    stream.on('end', () => {
      if (buffered) writeServerLog(buffered);
    });
  }

  child.on('error', (error) => {
    writeServerLog(`[typsidian] server process error: ${error.stack ?? error}`);
    if (!quitting) failFatal(new Error(`The Typsidian server failed to start: ${error.message}`));
  });
  child.on('exit', (code, signal) => {
    serverProcess = null;
    writeServerLog(`[typsidian] server exited code=${code} signal=${signal ?? 'none'}`);
    if (!quitting && code !== 0) {
      failFatal(new Error(`The Typsidian server stopped unexpectedly (code ${code}).`));
    }
  });

  return waitForHealth(port);
}

function writeServerLog(line) {
  if (line.length > 0) console.log(`[server] ${line}`);
  if (serverLogStream) serverLogStream.write(`[${new Date().toISOString()}] ${line}\n`);
}

/** Poll `GET /api/health` until the forked server answers. */
function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const retry = (reason) => {
      if (Date.now() > deadline) {
        reject(
          new Error(
            `The Typsidian server did not become ready in ${HEALTH_TIMEOUT_MS / 1000}s (${reason})`,
          ),
        );
        return;
      }
      setTimeout(attempt, HEALTH_INTERVAL_MS);
    };

    const attempt = () => {
      const request = http.get(
        { host: HOST, port, path: '/api/health', timeout: 1000 },
        (response) => {
          response.resume();
          if (response.statusCode === 200) resolve();
          else retry(`health returned ${response.statusCode}`);
        },
      );
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', (error) => retry(error.message));
    };

    attempt();
  });
}

function stopServer() {
  if (serverProcess) bootLog('stopping the server');
  const child = serverProcess;
  serverProcess = null;
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  const forceKill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 1500);
  forceKill.unref?.();
  if (serverLogStream) {
    serverLogStream.end();
    serverLogStream = null;
  }
}

async function failFatal(error) {
  const message = error instanceof Error ? error.message : String(error);
  bootLog(`fatal: ${message}`);
  console.error(`[typsidian] ${message}`);
  quitting = true;
  stopServer();
  const show = () => dialog.showErrorBox('Typsidian could not start', message);
  if (app.isReady()) show();
  else app.once('ready', show);
  app.quit();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow(port) {
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#131317',
    title: APP_NAME,
    // Native macOS look: traffic lights float over the app's own toolbar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow = window;

  window.on('ready-to-show', () => {
    window.show();
    window.focus();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on('did-finish-load', scheduleMenuRebuild);
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (quitting || code === -3 /* ABORTED: navigation superseded */) return;
    console.error(`[typsidian] failed to load ${url}: ${description} (${code})`);
  });

  // Links open in the user's browser, never in the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Recent vaults change while the app is open: refresh the menu on focus.
  window.on('focus', scheduleMenuRebuild);

  // `TYPSIDIAN_DEV_URL` lets `bun run dev:web` (vite, HMR) drive the shell.
  const devUrl = process.env.TYPSIDIAN_DEV_URL;
  const url = devUrl ? devUrl : `http://${HOST}:${port}/`;
  console.log(`[typsidian] window    ${url}`);
  await window.loadURL(url);
  return window;
}

/** The window menu actions should target (focused window, else the main one). */
function targetWindow() {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

/**
 * Invoke a renderer command from `window.__typsidianMenu` (web/src/store.ts).
 *
 * Menus express intent, so they go through the app store rather than a second
 * IPC path. `executeJavaScript` rejects while the page is loading; the caller
 * only logs that, because a menu click before load cannot do anything anyway.
 */
async function runMenuCommand(command, args = []) {
  const window = targetWindow();
  if (!window || window.webContents.isDestroyed()) return false;
  const call = `window.__typsidianMenu?.${command}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
  try {
    const applied = await window.webContents.executeJavaScript(
      `(() => { try { ${call}; return true; } catch (error) { console.error('[typsidian] ${command} failed', error); return false; } })()`,
      true,
    );
    if (!applied) console.error(`[typsidian] renderer has no __typsidianMenu.${command} yet`);
    scheduleMenuRebuild();
    // Vault commands record the new recent entry asynchronously (renderer →
    // server); a second pass makes "Recent Vaults" current without waiting for
    // the next window focus.
    setTimeout(() => void rebuildMenu(), 900);
    return applied !== false;
  } catch (error) {
    console.error(`[typsidian] ${command} unavailable: ${error.message ?? error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function scheduleMenuRebuild() {
  if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    void rebuildMenu();
  }, 120);
}

/** `GET /api/app` from the local server; null when the API is not ready yet. */
function fetchAppInfo() {
  return new Promise((resolve) => {
    if (!serverPort) {
      resolve(null);
      return;
    }
    const request = http.get(
      { host: HOST, port: serverPort, path: '/api/app', timeout: 2000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed && typeof parsed === 'object' ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function rebuildMenu() {
  const info = await fetchAppInfo();
  lastRecentVaults = Array.isArray(info?.recent) ? info.recent : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function buildMenuTemplate() {
  const recent = lastRecentVaults.slice(0, RECENT_LIMIT);
  const recentItems =
    recent.length === 0
      ? [{ label: 'No Recent Vaults', enabled: false }]
      : recent.map((vault) => ({
          label: vault.title || vault.root,
          toolTip: vault.root,
          // Missing folders stay visible (Obsidian-style) but greyed out.
          enabled: Boolean(vault.exists),
          click: () => void runMenuCommand('openVault', [vault.root]),
        }));

  return [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', enabled: false },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Vault…', accelerator: 'CmdOrCtrl+O', click: () => void chooseAndOpenVault() },
        { label: 'New Vault…', accelerator: 'Shift+CmdOrCtrl+N', click: () => void runMenuCommand('newVault') },
        { label: 'Recent Vaults', submenu: recentItems },
        { type: 'separator' },
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => void runMenuCommand('newNote') },
        { type: 'separator' },
        { label: 'Close Vault', click: () => void runMenuCommand('closeVault') },
        { label: 'Export PDF…', accelerator: 'Shift+CmdOrCtrl+E', click: () => void runMenuCommand('exportPdf') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => void runMenuCommand('toggleSidebar') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Typsidian Docs', click: () => void shell.openExternal('https://typst.app/docs/') },
        { label: 'Typst Website', click: () => void shell.openExternal('https://typst.app') },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Menu actions that need the native shell
// ---------------------------------------------------------------------------

/**
 * File > Open Vault…: native folder picker, then hand the path to the app store
 * (`__typsidianMenu.openVault`), which switches vaults and updates recents.
 */
async function chooseAndOpenVault() {
  const window = targetWindow();
  const result = await dialog.showOpenDialog(window ?? undefined, {
    title: 'Open Vault',
    message: 'Choose a folder to use as a vault',
    buttonLabel: 'Open Vault',
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const opened = await runMenuCommand('openVault', [result.filePaths[0]]);
  if (!opened) {
    // Very old renderer build: fall back to the HTTP API + a reload.
    const result2 = await requestJson('/api/vault/open', 'POST', { path: result.filePaths[0] });
    if (result2 !== undefined) await reloadRenderer();
  }
}

/** Last-resort fallback used only when the renderer menu API is missing. */
async function reloadRenderer() {
  const window = targetWindow();
  if (!window || window.webContents.isDestroyed()) return;
  try {
    await window.loadURL(`http://${HOST}:${serverPort}/`);
  } catch (error) {
    console.error(`[typsidian] reload failed: ${error.message ?? error}`);
  }
}

/** POST JSON to the local server; resolves to the parsed body or undefined. */
function requestJson(pathname, method, payload) {
  return new Promise((resolve) => {
    if (!serverPort) {
      resolve(undefined);
      return;
    }
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const request = http.request(
      {
        host: HOST,
        port: serverPort,
        path: pathname,
        method,
        timeout: 4000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch {
              resolve({});
            }
          } else {
            console.error(
              `[typsidian] ${method} ${pathname} → ${response.statusCode} ${text.slice(0, 300)}`,
            );
            resolve(undefined);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', (error) => {
      console.error(`[typsidian] ${method} ${pathname} failed: ${error.message}`);
      resolve(undefined);
    });
    request.end(body);
  });
}

// ---------------------------------------------------------------------------
// IPC — the preload bridge (web/src/contracts.ts DesktopBridge)
// ---------------------------------------------------------------------------

function registerIpc() {
  // Native folder picker: open a vault folder.
  ipcMain.handle('vault:choose-folder', async (event) => {
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
      {
        title: 'Open Vault',
        message: 'Choose a folder to use as a vault',
        buttonLabel: 'Open Vault',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      },
    );
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // Native folder picker: parent folder for a new vault.
  ipcMain.handle('vault:choose-new-parent', async (event) => {
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
      {
        title: 'New Vault',
        message: 'Choose where the new vault folder should be created',
        buttonLabel: 'Choose Folder',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      },
    );
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // "Reveal in Finder" for the open vault.
  ipcMain.handle('vault:reveal', async (_event, vaultPath) => {
    const target = typeof vaultPath === 'string' && vaultPath ? vaultPath : app.getPath('documents');
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        const error = await shell.openPath(target);
        if (error) shell.showItemInFolder(target);
        return true;
      }
      shell.showItemInFolder(target);
      return true;
    } catch (error) {
      console.error(`[typsidian] reveal failed: ${error.message ?? error}`);
      return false;
    }
  });

  // Synchronous version: the preload needs the version before the page loads.
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion();
  });

  // Open http(s) URLs in the user's browser — never file:// or custom schemes.
  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      console.error(`[typsidian] openExternal failed: ${error.message ?? error}`);
      return false;
    }
  });

  // The renderer owns the app theme; keep the native appearance in step so the
  // window chrome (traffic lights, native menus, dialogs) matches it.
  ipcMain.on('theme:sync', (_event, theme) => {
    if (theme !== 'light' && theme !== 'dark') return;
    if (nativeTheme.themeSource !== theme) {
      nativeTheme.themeSource = theme;
    }
  });

  ipcMain.on('app:reload', () => {
    const window = targetWindow();
    if (window && !window.webContents.isDestroyed()) window.webContents.reload();
  });
}
