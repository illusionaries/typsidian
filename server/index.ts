/**
 * Typsidian local server.
 *
 * Serves the JSON API used by the editor and (in production) the built web app.
 * The heavy lifting (Typst compilation, fonts, vault IO) happens here so the
 * browser stays snappy and the app can use real system fonts.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import type {
  ApiFailure,
  FileContent,
  HealthInfo,
  RenderSuccess,
  SavedFile,
  WorkspaceInfo,
} from '../shared/protocol';
import { adapterForPath } from './engine/registry';
import { Vault } from './vault';

const PORT = Number(process.env.TYPSIDIAN_PORT ?? 4747);
const HOST = process.env.TYPSIDIAN_HOST ?? '127.0.0.1';
const DEFAULT_VAULT = path.resolve(
  new URL('../sample-vault', import.meta.url).pathname,
);

function findVaultRoot(): string {
  const fromEnv = process.env.TYPSIDIAN_VAULT;
  if (fromEnv) return path.resolve(fromEnv);
  return fs.existsSync(DEFAULT_VAULT) ? DEFAULT_VAULT : process.cwd();
}

const vault = new Vault(findVaultRoot());
const app = express();

app.use(express.json({ limit: '8mb' }));

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

app.get('/api/health', (_request, response) => {
  const info: HealthInfo = {
    ok: true,
    workspace: vault.root,
    version: process.env.npm_package_version ?? '0.1.0',
    engine: 'typst (native, typst.ts)',
    fonts: 0,
  };
  response.json(info);
});

app.get('/api/workspace', (_request, response) => {
  const info: WorkspaceInfo = vault.info();
  response.json(info);
});

app.get('/api/file', (request, response) => {
  const relativePath = String(request.query.path ?? '');
  if (!relativePath) {
    sendFailure(response, 400, 'bad-request', 'missing ?path');
    return;
  }
  try {
    const content: FileContent = vault.read(relativePath);
    response.json(content);
  } catch (error) {
    sendFailure(response, 404, 'not-found', messageOf(error));
  }
});

app.put('/api/file', (request, response) => {
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
  };
  if (!relativePath || typeof source !== 'string') {
    sendFailure(response, 400, 'bad-request', 'expected { path, source }');
    return;
  }
  try {
    const saved: SavedFile = vault.write(relativePath, source);
    response.json(saved);
  } catch (error) {
    sendFailure(response, 500, 'io', messageOf(error));
  }
});

app.post('/api/file', (request, response) => {
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
  };
  if (!relativePath) {
    sendFailure(response, 400, 'bad-request', 'expected { path }');
    return;
  }
  try {
    const entry = vault.create(relativePath, source ?? '');
    response.json(entry);
  } catch (error) {
    sendFailure(response, 409, 'io', messageOf(error));
  }
});

app.post('/api/rename', (request, response) => {
  const { from, to } = (request.body ?? {}) as { from?: string; to?: string };
  if (!from || !to) {
    sendFailure(response, 400, 'bad-request', 'expected { from, to }');
    return;
  }
  try {
    response.json(vault.rename(from, to));
  } catch (error) {
    sendFailure(response, 409, 'io', messageOf(error));
  }
});

app.delete('/api/file', (request, response) => {
  const relativePath = String(request.query.path ?? '');
  try {
    vault.remove(relativePath);
    response.json({ ok: true });
  } catch (error) {
    sendFailure(response, 404, 'not-found', messageOf(error));
  }
});

app.post('/api/render', async (request, response) => {
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
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
      filePath: vault.absolute(relativePath),
      vaultRoot: vault.root,
      files: {},
    });
    const payload: RenderSuccess = { ok: true, ...result };
    response.json(payload);
  } catch (error) {
    sendFailure(response, 500, 'render', messageOf(error));
  }
});

app.post('/api/export/pdf', async (request, response) => {
  const { path: relativePath, source } = (request.body ?? {}) as {
    path?: string;
    source?: string;
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
      filePath: vault.absolute(relativePath!),
      vaultRoot: vault.root,
      files: {},
    });
    const name = path.basename(relativePath!).replace(/\.[^.]+$/, '') || 'document';
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
    response.end(Buffer.from(bytes));
  } catch (error) {
    sendFailure(response, 500, 'render', messageOf(error));
  }
});

// Serve the built web app when it exists (production mode).
const dist = path.resolve(new URL('../dist', import.meta.url).pathname);
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    response.sendFile(path.join(dist, 'index.html'));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[typsidian] server  http://${HOST}:${PORT}`);
  console.log(`[typsidian] vault   ${vault.root}`);
  console.log(`[typsidian] files   ${vault.list().length}`);
  if (!fs.existsSync(dist)) {
    console.log('[typsidian] hint    run `npm run dev:web` and open http://localhost:5173');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
