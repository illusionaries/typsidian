/**
 * Typst document adapter — the heavy half of the Typst language plugin.
 *
 * Pipeline
 * --------
 * 1. `splitBlocks` splits markup into layout-safe blocks. The native parser
 *    (`native/`, uses the real Typst parser) is preferred; the heuristic in
 *    `blocks.ts` is the fallback when the binary is not built.
 * 2. The source is *instrumented* with invisible, layout-neutral
 *    `#context[#metadata(... here().position() ...)]` marker lines in front of
 *    every block. Typst introspection then tells us exactly where each block
 *    landed, in page-local points — this is what powers "click the rendered
 *    result to jump to / edit the source".
 * 3. The clean (uninstrumented) source is compiled to a rich SVG, split into
 *    one self-contained SVG per page.
 * 4. Marker positions are folded into page-local rectangles per block.
 *
 * Rendering never throws: any failure is returned as a diagnostic plus whatever
 * partial result is available (blocks are always there). The expensive part is
 * cached by content hash, so re-rendering an unchanged document is cheap, and
 * repeated renders also skip the instrumentation compile.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

import type {
  AdapterEnv,
  BlockBox,
  DocBlock,
  DocumentAdapter,
  OutlineItem,
  RenderDiagnostic,
  RenderResult,
  RenderedBlock,
  RenderedPage,
} from '../../../shared/doc';
import { splitBlocks } from './native-parser';
import { instrument, MARKER_KEY } from './markers';
import { slicePageSvg, splitSvgIntoPages } from './svg';
import { buildGeometry, type MarkerPosition } from './geometry';
import {
  cachedCliDiagnostics,
  cliDiagnosticsAvailable,
  collectCompileDiagnostics,
  hashText,
  mergeDiagnostics,
  runCliDiagnostics,
} from './adapter-diagnostics';

const FONT_PATHS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(os.homedir(), 'Library/Fonts'),
].filter((dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
});

const RENDER_CACHE_LIMIT = 48;
/** A render this long after the previous one means the user paused typing. */
const CLI_IDLE_MS = 700;

export interface TypstAdapterOptions {
  /** Extra font directories. */
  fontPaths?: string[];
  /** Use the local `typst` CLI to fill in diagnostics without ranges. */
  cliDiagnostics?: boolean;
}

interface CoreRender {
  key: string;
  blocks: DocBlock[];
  pages: RenderedPage[];
  markers: MarkerPosition[];
  boxes: BlockBox[];
  /** Diagnostics known without a subprocess (messages and, usually, ranges). */
  inMemory: RenderDiagnostic[];
  svgBytes: number;
  renderMs: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Turn metadata query results into one marker position per block boundary.
 *
 * Returns `[]` unless every boundary is present: partial geometry would place
 * boxes on the wrong blocks, which is worse than no boxes at all (the UI falls
 * back to "no hit testing" cleanly).
 */
function parseMarkers(raw: unknown, expected: number): MarkerPosition[] {
  if (!Array.isArray(raw) || expected <= 0) return [];
  const positions: Array<MarkerPosition & { index: number }> = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const index = record[MARKER_KEY];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
    const page = typeof record.page === 'number' ? Math.max(1, Math.round(record.page)) : 1;
    positions.push({
      index,
      page: page - 1,
      x: toPt(record.x),
      y: toPt(record.y),
    });
  }
  if (positions.length !== expected) return [];
  positions.sort((a, b) => a.index - b.index);
  const markers: MarkerPosition[] = [];
  for (let index = 0; index < expected; index++) {
    if (positions[index].index !== index) return [];
    markers.push({ page: positions[index].page, x: positions[index].x, y: positions[index].y });
  }
  return markers;
}

/** Outline items derived from heading blocks. */
function outlineOf(blocks: DocBlock[]): OutlineItem[] {
  const outline: OutlineItem[] = [];
  for (const block of blocks) {
    if (block.kind !== 'heading') continue;
    outline.push({
      id: block.id,
      blockId: block.id,
      depth: Math.max(0, (block.level ?? 1) - 1),
      text: block.label,
      range: block.range,
    });
  }
  return outline;
}

/** Resolve a vault-relative POSIX path without allowing escapes. */
function resolveInside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const absolute = path.resolve(base, relative.replace(/\\/g, '/'));
  const check = path.relative(base, absolute);
  if (check === '' || check.startsWith('..') || path.isAbsolute(check)) return null;
  return absolute;
}

/** Adapter implementation. */
export class TypstAdapter implements DocumentAdapter {
  readonly id = 'typst';
  readonly displayName = 'Typst';
  readonly extensions = ['.typ'] as const;
  readonly capabilities = {
    blockRendering: true,
    paginated: true,
    inlineTextEditing: true,
    pdfExport: true,
  };

  private readonly compilers = new Map<string, NodeCompiler>();
  /** Shadow overlays currently mapped into each compiler instance. */
  private readonly shadows = new Map<NodeCompiler, Set<string>>();
  private readonly cache = new Map<string, CoreRender>();
  private readonly lastRenderAt = new Map<string, number>();
  private readonly cliTimers = new Map<string, NodeJS.Timeout>();
  private revision = 0;
  private readonly fontPaths: string[];
  private readonly cliDiagnostics: boolean;

  constructor(options: TypstAdapterOptions = {}) {
    this.fontPaths = [...FONT_PATHS, ...(options.fontPaths ?? [])];
    this.cliDiagnostics = options.cliDiagnostics ?? true;
  }

  async parse(source: string): Promise<DocBlock[]> {
    return splitBlocks(source);
  }

  async render(source: string, env: AdapterEnv): Promise<RenderResult> {
    const started = performance.now();
    const key = this.cacheKey(source, env);
    const previous = this.lastRenderAt.get(env.filePath) ?? 0;
    const now = Date.now();
    const idle = now - previous >= CLI_IDLE_MS;
    this.lastRenderAt.set(env.filePath, now);

    let core = this.cache.get(key);
    if (core) {
      this.cache.delete(key);
      this.cache.set(key, core);
    } else {
      try {
        core = this.buildCore(key, source, env, started);
      } catch (error) {
        core = this.fallbackCore(key, source, started, messageOf(error));
      }
      this.cache.set(key, core);
      while (this.cache.size > RENDER_CACHE_LIMIT) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
    }

    let diagnostics = core.inMemory;
    try {
      diagnostics = await this.resolveDiagnostics(core, source, env, idle);
    } catch {
      /* diagnostics must never break a render */
    }

    return {
      language: this.id,
      blocks: core.blocks,
      pages: core.pages,
      boxes: core.boxes,
      diagnostics,
      outline: outlineOf(core.blocks),
      stats: {
        renderMs: Math.round((performance.now() - started) * 100) / 100,
        svgBytes: core.svgBytes,
        revision: ++this.revision,
      },
    };
  }

  /**
   * Render one block in isolation.
   *
   * This rides on the full page render (which is cached by content hash), slices
   * the block's rectangle out of its page SVG and returns it as a standalone
   * `<svg>` (the per-page SVG already inlines its glyph defs, so it is
   * self-contained). For a block that flows over several pages/columns the
   * first rect is used.
   */
  async renderBlock(block: DocBlock, source: string, env: AdapterEnv): Promise<RenderedBlock> {
    const result = await this.render(source, env);
    const box = result.boxes.find((candidate) => candidate.blockId === block.id);
    if (!box || box.rects.length === 0) {
      return { blockId: block.id, rects: [], html: undefined };
    }
    const rect = box.rects[0];
    const page = result.pages.find((candidate) => candidate.index === rect.page);
    const html = page ? (slicePageSvg(page, rect) ?? undefined) : undefined;
    return { blockId: block.id, rects: box.rects, html };
  }

  async pdf(source: string, env: AdapterEnv): Promise<Uint8Array> {
    const compiler = this.compilerFor(env.vaultRoot);
    this.applyOverlays(compiler, env, source);
    return new Uint8Array(compiler.pdf({ mainFilePath: env.filePath }));
  }

  // ------------------------------------------------------------------ render --

  private buildCore(key: string, source: string, env: AdapterEnv, started: number): CoreRender {
    const blocks = splitBlocks(source);
    const compiler = this.compilerFor(env.vaultRoot);
    this.applyOverlays(compiler, env, source);

    let pages: RenderedPage[] = [];
    let markers: MarkerPosition[] = [];
    let svgBytes = 0;
    const diagnostics: RenderDiagnostic[] = [];

    try {
      const compiled = compiler.compile({ mainFilePath: env.filePath });
      diagnostics.push(...collectCompileDiagnostics(compiler, compiled, source, env));

      if (compiled.result) {
        // 1. Rich SVG from the clean source.
        const svg = compiler.svg({ mainFilePath: env.filePath });
        svgBytes = svg.length;
        pages = splitSvgIntoPages(svg);

        // 2. Marker positions from the instrumented source. The clean source is
        //    restored immediately so a crash cannot leak the instrumentation
        //    into a later compile.
        const instrumented = instrument(source, blocks);
        if (instrumented !== source) {
          compiler.mapShadow(env.filePath, Buffer.from(instrumented));
          try {
            const rawMarkers = compiler.query(
              { mainFilePath: env.filePath },
              { selector: 'metadata', field: 'value' },
            );
            markers = parseMarkers(rawMarkers, blocks.length + 1);
          } finally {
            compiler.mapShadow(env.filePath, Buffer.from(source));
          }
        }
      } else if (diagnostics.length === 0) {
        diagnostics.push({ severity: 'error', message: 'Typst compilation failed', hints: [] });
      }
    } catch (error) {
      diagnostics.push({ severity: 'error', message: messageOf(error), hints: [] });
    }

    return {
      key,
      blocks,
      pages,
      markers,
      boxes: buildGeometry(blocks, markers, pages),
      inMemory: diagnostics,
      svgBytes,
      renderMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  /** Last-resort result if even the cache/build scaffolding fails. */
  private fallbackCore(key: string, source: string, started: number, message: string): CoreRender {
    let blocks: DocBlock[] = [];
    try {
      blocks = splitBlocks(source);
    } catch {
      /* ignore */
    }
    return {
      key,
      blocks,
      pages: [],
      markers: [],
      boxes: [],
      inMemory: [{ severity: 'error', message, hints: [] }],
      svgBytes: 0,
      renderMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  // -------------------------------------------------------------- diagnostics --

  /**
   * Diagnostics policy.
   *
   * In-memory diagnostics already carry ranges (and warnings), so the CLI is
   * only consulted for diagnostics that are missing a range. Even then it is
   * cached by content hash and gated: immediately after an error / after the
   * user paused typing it runs inline so the UI gets ranges right away; while
   * the user is typing it is debounced into a single background check whose
   * result the next render picks up. If the binary is missing, the in-memory
   * diagnostics are used as-is.
   */
  private async resolveDiagnostics(
    core: CoreRender,
    source: string,
    env: AdapterEnv,
    idle: boolean,
  ): Promise<RenderDiagnostic[]> {
    const base = core.inMemory;
    if (!this.cliDiagnostics) return base;
    if (!base.some((diagnostic) => !diagnostic.range)) return base;

    const cached = cachedCliDiagnostics(core.key);
    if (cached) return mergeDiagnostics(base, cached);
    if (!cliDiagnosticsAvailable()) return base;

    const hasError = base.some((diagnostic) => diagnostic.severity === 'error');
    if (hasError || idle) {
      const result = await runCliDiagnostics(core.key, source, env, { fontPaths: this.fontPaths });
      return mergeDiagnostics(base, result.diagnostics);
    }
    this.scheduleCliCheck(core.key, source, env);
    return base;
  }

  private scheduleCliCheck(key: string, source: string, env: AdapterEnv): void {
    const existing = this.cliTimers.get(env.filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.cliTimers.delete(env.filePath);
      void runCliDiagnostics(key, source, env, { fontPaths: this.fontPaths }).catch(() => undefined);
    }, CLI_IDLE_MS);
    timer.unref?.();
    this.cliTimers.set(env.filePath, timer);
  }

  // ---------------------------------------------------------------- overlays ---

  /**
   * Overlay the in-editor buffers onto the compiler's filesystem view.
   *
   * `mapShadow` keeps disk files untouched while letting the compiler see the
   * unsaved main file *and* unsaved siblings, so `#import "sibling.typ"` works
   * even before a save. Shadows from a previous render that are no longer
   * provided are unmapped so stale buffers cannot leak into later documents.
   */
  private applyOverlays(compiler: NodeCompiler, env: AdapterEnv, source: string): void {
    const next = new Set<string>();
    const overlay = (absolute: string, content: string): void => {
      try {
        compiler.mapShadow(absolute, Buffer.from(content));
        next.add(absolute);
      } catch {
        /* a path the compiler cannot virtualize just falls back to disk */
      }
    };
    overlay(env.filePath, source);
    for (const [relative, content] of Object.entries(env.files ?? {})) {
      if (typeof content !== 'string') continue;
      const absolute = resolveInside(env.vaultRoot, relative);
      if (absolute) overlay(absolute, content);
    }
    const previous = this.shadows.get(compiler);
    if (previous) {
      for (const old of previous) {
        if (next.has(old)) continue;
        try {
          compiler.unmapShadow(old);
        } catch {
          /* ignore */
        }
      }
    }
    this.shadows.set(compiler, next);
  }

  // ------------------------------------------------------------------- caches --

  private cacheKey(source: string, env: AdapterEnv): string {
    let filesSignature = '';
    const files = env.files ?? {};
    for (const key of Object.keys(files).sort()) {
      filesSignature += `${key}\u0001${hashText(String(files[key]))}\u0002`;
    }
    return hashText(`${env.filePath}\u0000${env.vaultRoot}\u0000${source}\u0000${filesSignature}`);
  }

  private compilerFor(vaultRoot: string): NodeCompiler {
    const existing = this.compilers.get(vaultRoot);
    if (existing) return existing;
    const compiler = NodeCompiler.create({
      workspace: vaultRoot,
      fontArgs: [{ fontPaths: this.fontPaths }],
    });
    this.compilers.set(vaultRoot, compiler);
    return compiler;
  }
}
