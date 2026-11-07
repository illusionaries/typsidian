/**
 * Diagnostics for the Typst adapter.
 *
 * Two sources are combined:
 *
 * 1. **In-memory (primary).** `compiler.fetchDiagnostics()` upgrades the
 *    message-only `shortDiagnostics` to diagnostics with exact source ranges
 *    (line + code-point column). This covers errors *and* warnings, needs no
 *    subprocess and works on unsaved buffers. This is what the UI normally
 *    sees.
 *
 * 2. **Local `typst` CLI (fallback).** Some diagnostics (internal compiler
 *    errors, package errors) can arrive without a range. For those we run
 *    `typst compile --diagnostic-format short` against a shadow copy of the
 *    workspace and parse `path:line:col: severity: message`. The shadow copy
 *    lets unsaved buffers and `#import "sibling.typ"` resolve correctly, and
 *    writing it into the OS temp directory keeps the vault untouched.
 *
 * The CLI is deliberately *not* run on every keystroke: its result is cached by
 * content hash, it only runs when the in-memory pass produced diagnostics
 * without ranges, and the adapter gates it behind an idle/debounce policy.
 *
 * Extra CLI hardening: `--ignore-system-fonts` plus an explicit `--font-path`
 * for every font directory the in-memory compiler got keeps both compilers on
 * the same font book and cuts startup from ~330ms to ~85ms.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import type { AdapterEnv, RenderDiagnostic } from '../../../shared/doc';
import type { NodeCompiler, NodeError } from '@myriaddreamin/typst-ts-node-compiler';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, hex encoded. Cheap content identity for caches. */
export function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isWarningSeverity(severity: unknown): boolean {
  return Number(severity) === 2;
}

function splitHints(message: string): { message: string; hints: string[] } {
  const marker = ', hints: ';
  const index = message.indexOf(marker);
  if (index < 0) return { message, hints: [] };
  return {
    message: message.slice(0, index),
    hints: message
      .slice(index + marker.length)
      .split(marker)
      .map((hint) => hint.trim())
      .filter(Boolean),
  };
}

/** Resolve a path the compiler reported to an absolute path, if possible. */
function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return path.resolve(value);
}

function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  return realPath(a) === realPath(b);
}

function vaultRelative(env: AdapterEnv, file: string): string | null {
  // Try the plain paths first (works for files that do not exist on disk yet,
  // e.g. an unsaved new note), then the symlink-resolved pair (macOS
  // /var -> /private/var, symlinked vaults).
  const pairs: Array<[string, string]> = [
    [path.resolve(env.vaultRoot), path.resolve(file)],
  ];
  try {
    pairs.push([fs.realpathSync.native(env.vaultRoot), fs.realpathSync.native(file)]);
  } catch {
    /* file does not exist yet; plain paths are enough */
  }
  for (const [root, absolute] of pairs) {
    const relative = path.relative(root, absolute);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line/column -> source offset
// ---------------------------------------------------------------------------

/**
 * Typst reports columns as 0-based *code point* offsets (LSP-style but
 * Unicode-scalar based, not UTF-16). Source offsets are UTF-16 string indices,
 * so astral characters have to be accounted for.
 */
class SourceLocator {
  private readonly source: string;
  private readonly lineStarts: number[];

  constructor(source: string) {
    this.source = source;
    this.lineStarts = [0];
    for (let index = 0; index < source.length; index++) {
      if (source.charCodeAt(index) === 10) this.lineStarts.push(index + 1);
    }
  }

  /** UTF-16 offset for a 0-based line and 0-based code-point column. */
  offset(line: number, character: number): number | null {
    if (!Number.isFinite(line) || line < 0 || line >= this.lineStarts.length) return null;
    const start = this.lineStarts[line];
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.source.length;
    let offset = start;
    let seen = 0;
    while (offset < end && seen < character) {
      const code = this.source.codePointAt(offset);
      offset += code !== undefined && code > 0xffff ? 2 : 1;
      seen++;
    }
    return Math.min(offset, end);
  }

  range(range: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | null | undefined): { from: number; to: number } | undefined {
    if (!range?.start || !range.end) return undefined;
    const from = this.offset(Number(range.start.line ?? 0), Number(range.start.character ?? 0));
    const to = this.offset(Number(range.end.line ?? 0), Number(range.end.character ?? 0));
    if (from == null || to == null) return undefined;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }
}

// ---------------------------------------------------------------------------
// In-memory diagnostics
// ---------------------------------------------------------------------------

interface FullDiagnostic {
  message?: unknown;
  path?: unknown;
  severity?: unknown;
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  } | null;
}

/**
 * Collect ranged diagnostics from an in-memory compile, including warnings.
 * Never throws; falls back to the range-less short diagnostics when the full
 * diagnostic API is unavailable.
 */
export function collectCompileDiagnostics(
  compiler: NodeCompiler,
  compiled: { takeDiagnostics(): NodeError | null; takeWarnings(): NodeError | null },
  source: string,
  env: AdapterEnv,
): RenderDiagnostic[] {
  const bundles: NodeError[] = [];
  try {
    const errors = compiled.takeDiagnostics();
    if (errors) bundles.push(errors);
  } catch {
    /* ignore */
  }
  try {
    const warnings = compiled.takeWarnings();
    if (warnings) bundles.push(warnings);
  } catch {
    /* ignore */
  }

  const locator = new SourceLocator(source);
  const entries: Array<Record<string, unknown>> = [];
  for (const bundle of bundles) {
    let upgraded = false;
    try {
      const full = compiler.fetchDiagnostics(bundle) as unknown;
      if (Array.isArray(full) && full.length > 0) {
        entries.push(...(full as Array<Record<string, unknown>>));
        upgraded = true;
      }
    } catch {
      /* fall back to the range-less short form below */
    }
    if (!upgraded) {
      try {
        const short = bundle.shortDiagnostics as unknown;
        if (Array.isArray(short)) entries.push(...(short as Array<Record<string, unknown>>));
      } catch {
        /* ignore */
      }
    }
  }

  const diagnostics: RenderDiagnostic[] = [];
  const seen = new Set<string>();
  const add = (diagnostic: RenderDiagnostic): void => {
    const key = `${diagnostic.severity}\u0000${diagnostic.message}\u0000${diagnostic.range?.from ?? ''}:${diagnostic.range?.to ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const entry of entries) {
    const severityNumber = Number(entry.severity ?? 1);
    // 1 = error, 2 = warning; other severities are internal traces.
    if (severityNumber !== 1 && severityNumber !== 2) continue;
    const severity: RenderDiagnostic['severity'] = isWarningSeverity(severityNumber) ? 'warning' : 'error';
    const parsed = splitHints(String(entry.message ?? 'compile error'));
    const reportedPath = normalizePath(entry.path);
    const own = reportedPath == null || sameFile(reportedPath, env.filePath);
    const range = own ? locator.range(entry.range as FullDiagnostic['range']) : undefined;
    const prefix = own ? '' : `${relativeLabel(env, reportedPath)}: `;
    add({ severity, message: `${prefix}${parsed.message}`, range, hints: parsed.hints });
  }

  return diagnostics;
}

function relativeLabel(env: AdapterEnv, absolute: string | null): string {
  if (!absolute) return '<typst>';
  return vaultRelative(env, absolute) ?? path.basename(absolute);
}

// ---------------------------------------------------------------------------
// Local `typst` CLI fallback
// ---------------------------------------------------------------------------

export interface CliOptions {
  /** Same font directories the node compiler was configured with. */
  fontPaths: string[];
  timeoutMs?: number;
}

export interface CliResult {
  diagnostics: RenderDiagnostic[];
  /** False when the binary is missing / unusable; callers may stop asking. */
  available: boolean;
}

const CLI_CACHE_LIMIT = 24;
const cliCache = new Map<string, RenderDiagnostic[]>();
const cliInflight = new Map<string, Promise<CliResult>>();
let cliUnavailable = false;

export function cliDiagnosticsAvailable(): boolean {
  return !cliUnavailable;
}

/** Cached ranged diagnostics for a content key, if the CLI already ran. */
export function cachedCliDiagnostics(key: string): RenderDiagnostic[] | undefined {
  const hit = cliCache.get(key);
  if (!hit) return undefined;
  cliCache.delete(key);
  cliCache.set(key, hit);
  return hit;
}

export function rememberCliDiagnostics(key: string, diagnostics: RenderDiagnostic[]): void {
  cliCache.set(key, diagnostics);
  while (cliCache.size > CLI_CACHE_LIMIT) {
    const oldest = cliCache.keys().next();
    if (oldest.done) break;
    cliCache.delete(oldest.value);
  }
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'target', '.typsidian']);
const MAX_MIRRORED_FILES = 3000;

/** Run the CLI for a content key; concurrent requests for one key share a run. */
export function runCliDiagnostics(
  key: string,
  source: string,
  env: AdapterEnv,
  options: CliOptions,
): Promise<CliResult> {
  const existing = cliInflight.get(key);
  if (existing) return existing;
  if (cliUnavailable) {
    return Promise.resolve({ diagnostics: [], available: false });
  }
  const promise = executeCli(source, env, options)
    .then((result) => {
      if (!result.available) {
        cliUnavailable = true;
      } else {
        rememberCliDiagnostics(key, result.diagnostics);
      }
      return result;
    })
    .catch((): CliResult => ({ diagnostics: [], available: !cliUnavailable }))
    .finally(() => {
      cliInflight.delete(key);
    });
  cliInflight.set(key, promise);
  return promise;
}

/** Test hook: reset module level state between suites. */
export function resetCliDiagnosticsState(): void {
  cliCache.clear();
  cliInflight.clear();
  cliUnavailable = false;
}

async function executeCli(source: string, env: AdapterEnv, options: CliOptions): Promise<CliResult> {
  const mainRelative = vaultRelative(env, env.filePath);
  if (!mainRelative) return { diagnostics: [], available: true };

  const overlays = new Map<string, string>([[mainRelative, source]]);
  for (const [relative, content] of Object.entries(env.files ?? {})) {
    if (typeof content !== 'string') continue;
    const normalized = normalizeRelative(relative);
    if (normalized) overlays.set(normalized, content);
  }

  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typsidian-diag-'));
  try {
    const safeVaultRoot = safeDirectory(env.vaultRoot);
    if (safeVaultRoot) mirrorVault(safeVaultRoot, shadowRoot, overlays);
    for (const [relative, content] of overlays) {
      writeShadowFile(shadowRoot, relative, content);
    }
    const args = ['compile', '--diagnostic-format', 'short'];
    const fontPaths = options.fontPaths.filter((dir) => safeDirectory(dir) !== null);
    if (fontPaths.length > 0) {
      args.push('--ignore-system-fonts');
      for (const dir of fontPaths) args.push('--font-path', dir);
    }
    args.push('--root', shadowRoot, mainRelative, path.join(shadowRoot, 'typsidian-check.pdf'));

    const stderr = await spawnTypst(args, shadowRoot, options.timeoutMs ?? 5000);
    const locator = new SourceLocator(source);
    const diagnostics: RenderDiagnostic[] = [];
    for (const line of stderr.split('\n')) {
      const match = /^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const reported = match[1].trim();
      const absolute = path.isAbsolute(reported) ? reported : path.resolve(shadowRoot, reported);
      const relative = path.relative(shadowRoot, absolute).split(path.sep).join('/');
      const severity: RenderDiagnostic['severity'] = match[4] === 'warning' ? 'warning' : 'error';
      const parsed = splitHints(match[5]);
      const own = relative === mainRelative;
      let range: { from: number; to: number } | undefined;
      if (own) {
        // The short format only knows the start of the span; underline one
        // character so the UI has something to mark.
        const start = locator.offset(Number(match[2]) - 1, Number(match[3]) - 1);
        if (start != null) range = { from: start, to: Math.min(source.length, start + 1) };
      }
      const prefix = own ? '' : `${relative}: `;
      diagnostics.push({ severity, message: `${prefix}${parsed.message}`, range, hints: [] });
    }
    return { diagnostics, available: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { diagnostics: [], available: false };
    }
    return { diagnostics: [], available: true };
  } finally {
    try {
      fs.rmSync(shadowRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Resolve a vault-relative POSIX path, rejecting escapes. */
function normalizeRelative(value: string): string | null {
  const cleaned = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned === '') return null;
  const parts = cleaned.split('/');
  if (parts.some((part) => part === '' || part === '..' || part === '.')) return null;
  return parts.join('/');
}

function safeDirectory(dir: string): string | null {
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Hard-link (or copy) the workspace into the shadow root. */
function mirrorVault(root: string, shadowRoot: string, overlays: Map<string, string>): void {
  let mirrored = 0;
  const walk = (relativeDir: string, depth: number): void => {
    if (mirrored >= MAX_MIRRORED_FILES || depth > 12) return;
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (mirrored >= MAX_MIRRORED_FILES) return;
      if (entry.name.startsWith('.') || entry.name.endsWith('~') || entry.name.endsWith('.swp')) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(absoluteDir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(absolute);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        try {
          fs.mkdirSync(path.join(shadowRoot, relative), { recursive: true });
        } catch {
          continue;
        }
        walk(relative, depth + 1);
        continue;
      }
      if (!isFile) continue;
      if (overlays.has(relative)) continue; // written later by the caller
      const target = path.join(shadowRoot, relative);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.linkSync(absolute, target);
        } catch {
          fs.copyFileSync(absolute, target);
        }
        mirrored++;
      } catch {
        /* best effort: diagnostics still work without every asset */
      }
    }
  };
  walk('', 0);
}

/**
 * Write an overlay file into the shadow root.
 *
 * The unlink is essential: mirrored files are hard links, so writing through
 * one would modify the user's actual vault file.
 */
function writeShadowFile(shadowRoot: string, relative: string, content: string): void {
  const target = path.join(shadowRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.unlinkSync(target);
  } catch {
    /* not there yet */
  }
  fs.writeFileSync(target, content, 'utf8');
}

function spawnTypst(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('typst', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (error) {
        const failure = error as NodeJS.ErrnoException & { stderr?: string };
        if (failure.code === 'ENOENT') {
          reject(error);
          return;
        }
        // A non-zero exit code simply means "the document has diagnostics".
        resolve(failure.stderr ?? stderr ?? '');
        return;
      }
      resolve(stderr ?? '');
    });
  });
}

/** Merge CLI ranges into in-memory diagnostics by message when possible. */
export function mergeDiagnostics(
  base: RenderDiagnostic[],
  cli: RenderDiagnostic[],
): RenderDiagnostic[] {
  if (cli.length === 0) return base;
  const byMessage = new Map<string, RenderDiagnostic[]>();
  for (const diagnostic of cli) {
    const key = `${diagnostic.severity}\u0000${diagnostic.message}`;
    const list = byMessage.get(key);
    if (list) list.push(diagnostic);
    else byMessage.set(key, [diagnostic]);
  }
  return base.map((diagnostic) => {
    if (diagnostic.range) return diagnostic;
    const candidates = byMessage.get(`${diagnostic.severity}\u0000${diagnostic.message}`);
    if (!candidates || candidates.length === 0) return diagnostic;
    return { ...diagnostic, range: candidates[0].range ?? diagnostic.range };
  });
}
