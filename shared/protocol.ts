/**
 * Typsidian — client <-> server protocol.
 *
 * The browser never imports a language engine directly: it always talks to the
 * local server through these request/response shapes. That keeps the JS bundle
 * small, gives us native-speed compilation with real system fonts, and lets a
 * future Markdown/other-language adapter live behind the same API.
 */

import type { RenderResult } from './doc';

export interface FileEntry {
  /** Path relative to the workspace root, POSIX separators, e.g. "notes/x.typ". */
  path: string;
  name: string;
  /** Adapter id, e.g. "typst". Unknown extensions are "plain". */
  language: string;
  /** Last modification time, epoch ms. */
  mtime: number;
  size: number;
}

export interface WorkspaceInfo {
  /** Absolute workspace root. */
  root: string;
  /** Human friendly title (folder name). */
  title: string;
  files: FileEntry[];
  /** Adapter ids the server knows about. */
  languages: Array<{ id: string; displayName: string; extensions: string[] }>;
}

export interface FileContent {
  path: string;
  source: string;
  mtime: number;
  language: string;
}

export interface RenderRequest {
  /** Path relative to workspace root. */
  path: string;
  /** Current in-editor source (may be unsaved). */
  source: string;
  /**
   * Other files of the workspace, used to resolve imports. Optional: if
   * omitted the server reads the rest from disk.
   */
  files?: Record<string, string>;
}

export interface RenderSuccess extends RenderResult {
  ok: true;
}

export interface ApiFailure {
  ok: false;
  error: {
    kind: 'not-found' | 'io' | 'render' | 'bad-request' | 'internal';
    message: string;
  };
}

export type ApiResult<T> = T | ApiFailure;

export interface SavedFile {
  path: string;
  mtime: number;
}

export interface ExportPdfRequest {
  path: string;
  source: string;
  /** Unsaved sibling buffers, vault-relative path -> content. */
  files?: Record<string, string>;
}

/** Health/ready probe used by the UI splash screen. */
export interface HealthInfo {
  ok: true;
  workspace: string;
  version: string;
  /** Compiler backend description, e.g. "typst 0.15 (native)". */
  engine: string;
  fonts: number;
}

export const API = {
  health: '/api/health',
  workspace: '/api/workspace',
  file: '/api/file',
  render: '/api/render',
  pdf: '/api/export/pdf',
} as const;
