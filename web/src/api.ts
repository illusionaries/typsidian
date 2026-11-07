/**
 * Typed client for the Typsidian server API.
 */

import type { RenderResult } from '../../shared/doc';
import type {
  ApiFailure,
  ExportPdfRequest,
  FileContent,
  HealthInfo,
  RenderRequest,
  RenderSuccess,
  SavedFile,
  WorkspaceInfo,
} from '../../shared/protocol';
import { API, APP_API } from '../../shared/protocol';
import type { AppInfo } from '../../shared/protocol';

export class ApiError extends Error {
  readonly kind: ApiFailure['error']['kind'];
  constructor(kind: ApiFailure['error']['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let kind: ApiFailure['error']['kind'] = 'internal';
    try {
      const body = (await response.json()) as ApiFailure;
      if (body && body.ok === false) {
        message = body.error.message;
        kind = body.error.kind;
      }
    } catch {
      /* keep default */
    }
    throw new ApiError(kind, message);
  }
  return (await response.json()) as T;
}

function isOk<T extends { ok: boolean }>(value: T | ApiFailure): value is T {
  return (value as { ok?: boolean }).ok !== false;
}

export const api = {
  health(): Promise<HealthInfo> {
    return request<HealthInfo>(API.health);
  },

  workspace(): Promise<WorkspaceInfo> {
    return request<WorkspaceInfo>(API.workspace);
  },

  readFile(path: string): Promise<FileContent> {
    return request<FileContent>(`${API.file}?path=${encodeURIComponent(path)}`);
  },

  writeFile(path: string, source: string): Promise<SavedFile> {
    return request<SavedFile>(API.file, {
      method: 'PUT',
      body: JSON.stringify({ path, source }),
    });
  },

  createFile(path: string, source = ''): Promise<SavedFile & { name: string }> {
    return request(`${API.file}`, {
      method: 'POST',
      body: JSON.stringify({ path, source }),
    });
  },

  renameFile(from: string, to: string): Promise<{ from: string; to: string }> {
    return request('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  },

  deleteFile(path: string): Promise<{ ok: boolean }> {
    return request(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  },

  async render(payload: RenderRequest): Promise<RenderResult> {
    const result = await request<RenderSuccess | ApiFailure>(API.render, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!isOk(result)) throw new ApiError(result.error.kind, result.error.message);
    return result;
  },

  async exportPdf(payload: ExportPdfRequest): Promise<Blob> {
    const response = await fetch(API.pdf, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as ApiFailure;
        if (body && body.ok === false) message = body.error.message;
      } catch {
        /* ignore */
      }
      throw new ApiError('render', message);
    }
    return response.blob();
  },
};

// ---------------------------------------------------------------------------
// Vault management (standalone app)
// ---------------------------------------------------------------------------


export const vaultApi = {
  app(): Promise<AppInfo> {
    return request<AppInfo>(APP_API.app);
  },

  open(path: string): Promise<AppInfo> {
    return request<AppInfo>(APP_API.open, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  create(path?: string): Promise<AppInfo> {
    return request<AppInfo>(APP_API.create, {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    });
  },

  sample(): Promise<AppInfo> {
    return request<AppInfo>(APP_API.sample, { method: 'POST', body: '{}' });
  },

  close(): Promise<AppInfo> {
    return request<AppInfo>(APP_API.close, { method: 'POST', body: '{}' });
  },

  removeRecent(path: string): Promise<AppInfo> {
    return request<AppInfo>(APP_API.recentRemove, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },
};
