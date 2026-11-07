/**
 * Typsidian local server.
 *
 * Serves the JSON API used by the editor and (in production) the built web app.
 * The heavy lifting (Typst compilation, fonts, vault IO) happens here so the
 * browser stays snappy and the app can use real system fonts.
 *
 * The workspace is *mutable*: the standalone app boots on a welcome screen and
 * switches between vaults at runtime (`/api/vault/open`, `/api/vault/create`,
 * `/api/vault/sample`, `/api/vault/close`). Everything that touches documents
 * goes through {@link requireVault}, so a missing vault is a clean 409 instead
 * of a crash.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import type {
  ApiFailure,
  AppInfo,
  FileContent,
  HealthInfo,
  RecentVault,
  RenderSuccess,
  SavedFile,
  WorkspaceInfo,
} from '../shared/protocol';
import { adapterForPath } from './engine/registry';
import {
  AppHome,
  Vault,
  VaultWatcher,
  canonicalPath,
  copySampleVault,
  createVaultDirectory,
  ensureDirectory,
  isDirectory,
  uniqueDirectory,
} from './vault';
import type { SearchHit, VaultEvent } from './vault';

const PORT = Number(process.env.TYPSIDIAN_PORT ?? 4747);
const HOST = process.env.TYPSIDIAN_HOST ?? '127.0.0.1';

/** Directory holding `config.json` and recent vaults. */
const HOME = new AppHome();
/** Real version string from package.json (never a hard-coded fallback). */
const VERSION = readAppVersion();
/** Bundled sample vault, when present. */
const SAMPLE_VAULT = findSampleVault();

// ---------------------------------------------------------------------------
// Mutable workspace state
// ---------------------------------------------------------------------------

let vault: Vault | null = null;
let watcher: VaultWatcher | null = null;
let unsubscribeWatcher: (() => void) | null = null;

/** Open `/api/events` responses; they survive vault switches. */
const eventClients = new Set<express.Response>();

const app = express();

app.use(express.json({ limit: '8mb' }));

// The vault can change under us (external editors, git checkouts, ...): the
// browser must never see a cached workspace listing.
app.use('/api', (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
});

function failure(kind: ApiFailure['error']['kind'], message: string): ApiFailure {
  return { ok: false, error: { kind, message } };
}

function sendFailure(
  response: express.Response,
  status: number,
  kind: ApiFailure['error']['kind'],
  message: string,
): void {
  response.status(status).json(failure(kind, message));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The active vault, or a 409 response when the app is on the welcome screen. */
function requireVault(response: express.Response): Vault | null {
  if (!vault) {
    sendFailure(response, 409, 'bad-request', 'no vault open');
    return null;
  }
  return vault;
}

/**
 * Point the server at a vault (or at nothing, for the welcome screen).
 * Stops the old watcher first so no events leak from the previous vault, then
 * persists the recent-vault list and restarts watching.
 */
function setVault(root: string | null): AppInfo {
  stopWatcher();
  if (root === null) {
    vault = null;
    HOME.setLastVault(null);
    return appInfo();
  }
  const canonical = canonicalPath(root);
  if (!isDirectory(canonical)) {
    throw new Error(`folder not found: ${root}`);
  }
  vault = new Vault(canonical);
  HOME.record(vault.root);
  startWatcher(vault.root);
  return appInfo();
}

function startWatcher(root: string): void {
  const next = new VaultWatcher(root, {
    debounceMs: 150,
    onError: (error) => console.warn(`[typsidian] watcher: ${messageOf(error)}`),
  });
  unsubscribeWatcher = next.subscribe(broadcastEvents);
  try {
    next.start();
  } catch (error) {
    console.warn(`[typsidian] watcher failed to start: ${messageOf(error)}`);
  }
  watcher = next;
}

function stopWatcher(): void {
  if (unsubscribeWatcher) {
    try {
      unsubscribeWatcher();
    } catch {
      // ignore
    }
    unsubscribeWatcher = null;
  }
  if (watcher) {
    try {
      watcher.stop();
    } catch {
      // ignore
    }
    watcher = null;
  }
}

/** Push a vault-change batch to every connected SSE client. */
function broadcastEvents(events: VaultEvent[]): void {
  if (events.length === 0) return;
  const payload = `data: ${JSON.stringify(events)}\n\n`;
  for (const client of [...eventClients]) {
    try {
      client.write(payload);
    } catch {
      eventClients.delete(client);
    }
  }
}

/** Everything the shell needs at boot (and after every vault operation). */
function appInfo(): AppInfo {
  let workspace: WorkspaceInfo | null = null;
  if (vault) {
    try {
      workspace = vault.info();
    } catch (error) {
      console.warn(`[typsidian] cannot read vault: ${messageOf(error)}`);
      workspace = null;
    }
  }
  let recent: RecentVault[] = [];
  try {
    recent = HOME.recentVaults();
  } catch (error) {
    console.warn(`[typsidian] cannot read recent vaults: ${messageOf(error)}`);
  }
  return {
    vault: workspace,
    recent,
    home: HOME.dir,
    version: VERSION,
    sampleAvailable: SAMPLE_VAULT !== null,
  };
}

/** Only accept plain vault-relative paths with string content for overlays. */
function sanitizeFiles(files: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!files || typeof files !== 'object') return result;
  for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) continue;
    if (key.length > 512) continue;
    result[key] = value;
  }
  return result;
}

/** Read an absolute path from a request body, expanding `~`. */
function readPathField(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { path?: unknown }).path;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const expanded = value.trim().replace(/^~(?=\/|$)/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : null;
}

/** `~/Documents`, falling back to the home directory when it is missing. */
function documentsDirectory(): string {
  const override = process.env.TYPSIDIAN_SAMPLE_PARENT;
  if (override && override.trim()) return ensureDirectory(override.trim());
  const documents = path.join(os.homedir(), 'Documents');
  return isDirectory(documents) ? documents : os.homedir();
}

// ---------------------------------------------------------------------------
// App + vault management
// ---------------------------------------------------------------------------

app.get('/api/health', (_request, response) => {
  const info: HealthInfo = {
    ok: true,
    workspace: vault?.root ?? '',
    version: VERSION,
    engine: 'typst (native, typst.ts)',
    fonts: 0,
  };
  response.json(info);
});

app.get('/api/app', (_request, response) => {
  response.json(appInfo());
});

app.post('/api/vault/open', (request, response) => {
  const target = readPathField(request.body);
  if (!target) {
    sendFailure(response, 400, 'bad-request', 'expected { path: absolute folder path }');
    return;
  }
  const canonical = canonicalPath(target);
  if (!isDirectory(canonical)) {
    sendFailure(response, 404, 'not-found', `folder not found: ${target}`);
    return;
  }
  try {
    response.json(setVault(canonical));
  } catch (error) {
    sendFailure(response, 400, 'bad-request', messageOf(error));
  }
});

app.post('/api/vault/create', (request, response) => {
  const requested = readPathField(request.body);
  const target = requested ?? uniqueDirectory(path.join(documentsDirectory(), 'Typsidian Vault'));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const root = createVaultDirectory(target);
    response.json(setVault(root));
  } catch (error) {
    sendFailure(response, 400, 'io', `cannot create vault at ${target}: ${messageOf(error)}`);
  }
});

app.post('/api/vault/sample', (_request, response) => {
  if (!SAMPLE_VAULT) {
    sendFailure(response, 404, 'not-found', 'no bundled sample vault is available');
    return;
  }
  try {
    const destination = uniqueDirectory(path.join(documentsDirectory(), 'Typsidian Sample'));
    const root = copySampleVault(SAMPLE_VAULT, destination);
    response.json(setVault(root));
  } catch (error) {
    sendFailure(response, 500, 'io', `cannot import the sample vault: ${messageOf(error)}`);
  }
});

app.post('/api/vault/close', (_request, response) => {
  response.json(setVault(null));
});

app.post('/api/recent/remove', (request, response) => {
  const target = readPathField(request.body);
  if (!target) {
    sendFailure(response, 400, 'bad-request', 'expected { path: absolute folder path }');
    return;
  }
  try {
    HOME.removeRecent(target);
  } catch (error) {
    sendFailure(response, 500, 'internal', messageOf(error));
    return;
  }
  response.json(appInfo());
});

app.post('/api/vault/reveal', (request, response) => {
  const target = readPathField(request.body);
  if (!target) {
    sendFailure(response, 400, 'bad-request', 'expected { path: absolute folder path }');
    return;
  }
  // The Electron shell performs the actual reveal; validate here so a browser
  // build (and any future shell) cannot be tricked into revealing arbitrary
  // relative paths.
  if (!isDirectory(target)) {
    sendFailure(response, 404, 'not-found', `folder not found: ${target}`);
    return;
  }
  response.json({ ok: true, path: canonicalPath(target) });
});

// ---------------------------------------------------------------------------
// Workspace / documents
// ---------------------------------------------------------------------------

app.get('/api/workspace', (_request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const info: WorkspaceInfo = active.info();
  response.json(info);
});

app.get('/api/file', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const relativePath = String(request.query.path ?? '');
  if (!relativePath) {
    sendFailure(response, 400, 'bad-request', 'missing ?path');
    return;
  }
  try {
    const content: FileContent = active.read(relativePath);
    response.json(content);
  } catch (error) {
    sendFailure(response, 404, 'not-found', messageOf(error));
  }
});

app.put('/api/file', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
  };
  if (!relativePath || typeof source !== 'string') {
    sendFailure(response, 400, 'bad-request', 'expected { path, source }');
    return;
  }
  try {
    const saved: SavedFile = active.write(relativePath, source);
    response.json(saved);
  } catch (error) {
    sendFailure(response, 500, 'io', messageOf(error));
  }
});

app.post('/api/file', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
  };
  if (!relativePath) {
    sendFailure(response, 400, 'bad-request', 'expected { path }');
    return;
  }
  try {
    const entry = active.create(relativePath, source ?? '');
    response.json(entry);
  } catch (error) {
    sendFailure(response, 409, 'io', messageOf(error));
  }
});

app.post('/api/mkdir', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { path: relativePath } = (request.body ?? {}) as { path?: string };
  if (!relativePath) {
    sendFailure(response, 400, 'bad-request', 'expected { path }');
    return;
  }
  try {
    const created = active.mkdir(relativePath);
    response.json({ ok: true, path: created });
  } catch (error) {
    sendFailure(response, 409, 'io', messageOf(error));
  }
});

app.post('/api/rename', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { from, to } = (request.body ?? {}) as { from?: string; to?: string };
  if (!from || !to) {
    sendFailure(response, 400, 'bad-request', 'expected { from, to }');
    return;
  }
  try {
    response.json(active.rename(from, to));
  } catch (error) {
    sendFailure(response, 409, 'io', messageOf(error));
  }
});

app.delete('/api/file', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const relativePath = String(request.query.path ?? '');
  try {
    active.remove(relativePath);
    response.json({ ok: true });
  } catch (error) {
    sendFailure(response, 404, 'not-found', messageOf(error));
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

app.get('/api/search', (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const query = String(request.query.q ?? '');
  if (!query.trim()) {
    response.json({ ok: true, query, results: [] });
    return;
  }
  const requested = Number(request.query.limit ?? 50);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50;
  try {
    const results: SearchHit[] = active.search(query, limit);
    response.json({ ok: true, query, results });
  } catch (error) {
    sendFailure(response, 500, 'internal', messageOf(error));
  }
});

// ---------------------------------------------------------------------------
// File watching: Server-Sent Events
// ---------------------------------------------------------------------------

app.get('/api/events', (request, response) => {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  // Tell EventSource to reconnect quickly; a comment frames the connection.
  response.write('retry: 2000\n\n');
  response.write(': connected\n\n');

  eventClients.add(response);

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    eventClients.delete(response);
  };

  // Keep proxies and idle sockets from dropping the stream.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      response.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 20_000);

  request.on('close', cleanup);
  response.on('close', cleanup);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

app.post('/api/render', async (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { path: relativePath, source, files } = (request.body ?? {}) as {
    path?: string;
    source?: string;
    files?: Record<string, string>;
  };
  if (!relativePath || typeof source !== 'string') {
    sendFailure(response, 400, 'bad-request', 'expected { path, source }');
    return;
  }
  let adapter;
  try {
    adapter = adapterForPath(relativePath);
  } catch (error) {
    sendFailure(response, 500, 'internal', messageOf(error));
    return;
  }
  if (!adapter) {
    sendFailure(response, 415, 'bad-request', `no language engine for ${relativePath}`);
    return;
  }
  try {
    const result = await adapter.render(source, {
      filePath: active.absolute(relativePath),
      vaultRoot: active.root,
      files: sanitizeFiles(files),
    });
    const payload: RenderSuccess = { ok: true, ...result };
    response.json(payload);
  } catch (error) {
    sendFailure(response, 500, 'render', messageOf(error));
  }
});

app.post('/api/export/pdf', async (request, response) => {
  const active = requireVault(response);
  if (!active) return;
  const { path: relativePath, source, files } = (request.body ?? {}) as {
    path?: string;
    source?: string;
    files?: Record<string, string>;
  };
  const adapter = relativePath ? adapterForPath(relativePath) : null;
  if (!adapter || typeof source !== 'string') {
    sendFailure(response, 400, 'bad-request', 'expected { path, source }');
    return;
  }
  if (!adapter.pdf) {
    sendFailure(response, 415, 'bad-request', 'engine cannot export PDF');
    return;
  }
  try {
    const bytes = await adapter.pdf(source, {
      filePath: active.absolute(relativePath!),
      vaultRoot: active.root,
      files: sanitizeFiles(files),
    });
    const name = path.basename(relativePath!).replace(/\.[^.]+$/, '') || 'document';
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
    response.end(Buffer.from(bytes));
  } catch (error) {
    sendFailure(response, 500, 'render', messageOf(error));
  }
});

// ---------------------------------------------------------------------------
// Static web app (production / packaged shell)
// ---------------------------------------------------------------------------

const dist = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  // Express 5 / path-to-regexp 8 removed bare "*" routes; a terminal middleware
  // is the supported catch-all and keeps /api 404s intact.
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      next();
      return;
    }
    response.sendFile(path.join(dist, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Dev convenience: opening `TYPSIDIAN_VAULT` at boot is opt-in. The packaged
 * app deliberately starts on the welcome screen (the shell restores the last
 * vault by calling `/api/vault/open`, so the UI can show progress).
 */
function boot(): void {
  const fromEnv = process.env.TYPSIDIAN_VAULT?.trim();
  if (!fromEnv) return;
  try {
    setVault(fromEnv);
  } catch (error) {
    console.warn(`[typsidian] could not open TYPSIDIAN_VAULT: ${messageOf(error)}`);
  }
}

boot();

const server = app.listen(PORT, HOST, () => {
  console.log(`[typsidian] server  http://${HOST}:${PORT}`);
  console.log(`[typsidian] version ${VERSION}`);
  console.log(`[typsidian] home    ${HOME.dir}`);
  if (vault) {
    console.log(`[typsidian] vault   ${vault.root}`);
    try {
      console.log(`[typsidian] files   ${vault.list().length}`);
    } catch {
      // listing is best effort
    }
  } else {
    console.log('[typsidian] vault   (none — welcome screen)');
  }
  console.log(
    `[typsidian] sample  ${SAMPLE_VAULT ?? '(not bundled)'}`,
  );
  if (!fs.existsSync(dist)) {
    console.log('[typsidian] hint    run `bun run dev:web` and open http://localhost:5173');
  }
});

server.on('error', (error) => {
  console.error(`[typsidian] server error: ${messageOf(error)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopWatcher();
    for (const client of eventClients) {
      try {
        client.end();
      } catch {
        // already gone
      }
    }
    eventClients.clear();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    // Never leave a zombie server behind if a socket refuses to close.
    setTimeout(() => process.exit(0), 1000);
  });
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/**
 * Read the real version from the nearest `package.json` above this module.
 * Works in dev (`server/index.ts`) and in the packaged bundle
 * (`dist-server/server.js` next to the app's `package.json`).
 */
function readAppVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') return parsed.version;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.env.npm_package_version ?? '0.0.0';
}

/** Locate the bundled sample vault for "open sample". */
function findSampleVault(): string | null {
  const candidates: string[] = [];
  const fromEnv = process.env.TYPSIDIAN_SAMPLE_VAULT;
  if (fromEnv && fromEnv.trim()) candidates.push(path.resolve(fromEnv.trim()));
  // Repo layout: server/ or dist-server/ → ../sample-vault.
  candidates.push(fileURLToPath(new URL('../sample-vault', import.meta.url)));
  // Packaged Electron app: extraResources copies it next to the app bundle.
  const resources = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resources === 'string' && resources.trim() !== '') {
    candidates.push(path.join(resources, 'sample-vault'));
  }
  candidates.push(path.join(process.cwd(), 'sample-vault'));
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return canonicalPath(candidate);
  }
  return null;
}
