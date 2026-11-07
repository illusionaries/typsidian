/**
 * Typst document adapter — the heavy half of the Typst language plugin.
 *
 * Pipeline
 * --------
 * 1. `splitTypstBlocks` splits markup into layout-safe blocks.
 * 2. The source is *instrumented* with invisible, layout-neutral
 *    `#context[#metadata(... here().position() ...)]` marker lines in front of
 *    every block. Typst introspection then tells us exactly where each block
 *    landed, in page-local points — this is what powers "click the rendered
 *    result to jump to / edit the source".
 * 3. The clean (uninstrumented) source is compiled to a rich SVG, split into
 *    one self-contained SVG per page.
 * 4. Marker positions are folded into page-local rectangles per block.
 *
 * The instrumentation is provably layout neutral: an invisible metadata line
 * contributes nothing to the frame, so both compiles produce identical
 * geometry (verified by comparing page dimensions and glyph transforms).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

import type {
  AdapterEnv,
  DocBlock,
  DocumentAdapter,
  OutlineItem,
  RenderDiagnostic,
  RenderResult,
  RenderedPage,
  BlockBox,
} from '../../../shared/doc';
import { splitTypstBlocks } from './blocks';
import { splitSvgIntoPages } from './svg';

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

const MARKER_KEY = 'typsidian_block';
const RENDER_CACHE_LIMIT = 48;

interface MarkerPosition {
  page: number;
  x: number;
  y: number;
}

interface Compiled {
  pages: RenderedPage[];
  markers: MarkerPosition[];
  renderMs: number;
  svgBytes: number;
}

export interface TypstAdapterOptions {
  /** Extra font directories. */
  fontPaths?: string[];
  /** Use the local `typst` CLI for ranged diagnostics. */
  cliDiagnostics?: boolean;
}

/**
 * Build the marker line inserted in front of a block.
 *
 * `here().position()` is resolved by Typst's introspection inside a context
 * block; metadata has no layout footprint, so the inserted line is invisible.
 */
function markerLine(index: number): string {
  return (
    `#context[#metadata((` +
    `${MARKER_KEY}: ${index}, ` +
    `x: here().position().x, ` +
    `y: here().position().y, ` +
    `page: here().page() ` +
    `))]`
  );
}

/**
 * Insert marker lines directly in front of every block.
 * Markers are always placed at a line start, which keeps the markup valid even
 * for blocks that begin in the middle of a line.
 */
function instrument(source: string, blocks: DocBlock[]): string {
  const offsets = blocks.map((block) => {
    const lineStart = source.lastIndexOf('\n', block.range.from - 1) + 1;
    return lineStart;
  });
  // De-duplicate offsets (two blocks can share a line start when one follows
  // another without a newline) and keep them sorted.
  const insertions = new Map<number, number[]>();
  offsets.forEach((offset, blockIndex) => {
    const list = insertions.get(offset);
    if (list) list.push(blockIndex);
    else insertions.set(offset, [blockIndex]);
  });
  const points = [...insertions.keys()].sort((a, b) => a - b);
  if (points.length === 0) {
    return `${markerLine(0)}\n${source}\n${markerLine(1)}\n`;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const point of points) {
    parts.push(source.slice(cursor, point));
    for (const blockIndex of insertions.get(point)!) parts.push(markerLine(blockIndex), '\n');
    cursor = point;
  }
  parts.push(source.slice(cursor));
  // End-of-document marker: lets the last block know where it stops.
  parts.push('\n', markerLine(blocks.length), '\n');
  return parts.join('');
}

function toPt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseMarkers(raw: unknown, expected: number): MarkerPosition[] {
  if (!Array.isArray(raw)) return [];
  const markers: MarkerPosition[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record[MARKER_KEY] !== 'number') continue;
    const page = typeof record.page === 'number' ? record.page : 1;
    markers.push({
      page: Math.max(0, page - 1),
      x: toPt(record.x),
      y: toPt(record.y),
    });
  }
  if (markers.length !== expected) {
    // Partial results are still useful, but geometry needs a full set.
    return markers.length >= expected ? markers.slice(0, expected) : [];
  }
  return markers;
}

/** Fold marker positions into page-local rectangles per block. */
function buildGeometry(
  blocks: DocBlock[],
  markers: MarkerPosition[],
  pages: RenderedPage[],
): BlockBox[] {
  if (markers.length !== blocks.length + 1 || pages.length === 0) return [];
  // The very first marker sits before any page setup has been applied, so it
  // can report (0, 0). Derive the content margin from the markers that do have
  // a real position, then clamp everything into the content area.
  const realXs = markers.map((marker) => marker.x).filter((x) => x > 1);
  const margin = Math.max(0, (realXs.length > 0 ? Math.min(...realXs) : 0) - 2);
  const contentLeft = margin;
  for (const marker of markers) {
    marker.x = Math.max(marker.x, margin);
    marker.y = Math.max(marker.y, margin);
  }
  const boxes: BlockBox[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const start = markers[index];
    const end = markers[index + 1];
    const rects: BlockBox['rects'] = [];
    const startPage = Math.min(start.page, pages.length - 1);
    const endPage = Math.min(Math.max(end.page, startPage), pages.length - 1);
    const width = (page: number) => Math.max(40, pages[page].widthPt - contentLeft * 2);

    if (startPage === endPage) {
      const height = end.y - start.y;
      rects.push({
        page: startPage,
        x: contentLeft,
        y: Math.max(0, start.y - 2),
        width: width(startPage),
        height: Math.max(8, height),
      });
    } else {
      const first = pages[startPage];
      rects.push({
        page: startPage,
        x: contentLeft,
        y: Math.max(0, start.y - 2),
        width: width(startPage),
        height: Math.max(8, first.heightPt - start.y - contentLeft),
      });
      for (let page = startPage + 1; page < endPage; page++) {
        rects.push({
          page,
          x: contentLeft,
          y: Math.max(0, contentLeft),
          width: width(page),
          height: Math.max(8, pages[page].heightPt - contentLeft * 2),
        });
      }
      rects.push({
        page: endPage,
        x: contentLeft,
        y: Math.max(0, contentLeft),
        width: width(endPage),
        height: Math.max(8, end.y - contentLeft),
      });
    }
    boxes.push({ blockId: blocks[index].id, rects });
  }
  return boxes;
}

function lineColumnToOffset(source: string, line: number, column: number): number {
  let current = 1;
  let offset = 0;
  while (offset < source.length && current < line) {
    if (source.charCodeAt(offset) === 10) current++;
    offset++;
  }
  return Math.min(source.length, offset + Math.max(0, column - 1));
}

interface CliDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
}

/** Run the local `typst` CLI to obtain diagnostics with exact positions. */
function runCliDiagnostics(
  root: string,
  filePath: string,
  source: string,
): CliDiagnostic[] {
  const dir = path.dirname(filePath);
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tempSource = path.join(dir, `.typsidian-check-${stamp}.typ`);
  const tempOut = path.join(os.tmpdir(), `typsidian-check-${stamp}.pdf`);
  try {
    fs.writeFileSync(tempSource, source);
    const result = spawnSyncText(
      'typst',
      ['compile', '--diagnostic-format', 'short', '--root', root, tempSource, tempOut],
      Math.max(4000, 1200 + source.length / 8),
    );
    if (result == null) return [];
    const diagnostics: CliDiagnostic[] = [];
    for (const line of result.split('\n')) {
      const match = /^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      diagnostics.push({
        severity: match[4] === 'error' ? 'error' : 'warning',
        message: match[5].trim(),
        line: Number(match[2]),
        column: Number(match[3]),
      });
    }
    return diagnostics;
  } catch {
    return [];
  } finally {
    safeUnlink(tempSource);
    safeUnlink(tempOut);
  }
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function spawnSyncText(command: string, args: string[], timeoutMs: number): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  if (result.error) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Adapter implementation. */
export class TypstAdapter implements DocumentAdapter {
  readonly id = 'typst';
  readonly displayName = 'Typst';
  readonly extensions = ['.typ'] as const;
  readonly capabilities = {
    blockRendering: false,
    paginated: true,
    inlineTextEditing: true,
    pdfExport: true,
  };

  private readonly compilers = new Map<string, NodeCompiler>();
  private readonly cache = new Map<string, RenderResult>();
  private revision = 0;
  private readonly fontPaths: string[];
  private readonly cliDiagnostics: boolean;

  constructor(options: TypstAdapterOptions = {}) {
    this.fontPaths = [...FONT_PATHS, ...(options.fontPaths ?? [])];
    this.cliDiagnostics = options.cliDiagnostics ?? true;
  }

  async parse(source: string): Promise<DocBlock[]> {
    return splitTypstBlocks(source);
  }

  async render(source: string, env: AdapterEnv): Promise<RenderResult> {
    const blocks = splitTypstBlocks(source);
    const cacheKey = `${env.filePath}\u0000${source}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return { ...cached, blocks, stats: { ...cached.stats, revision: ++this.revision } };
    }

    const started = performance.now();
    const compiler = this.compilerFor(env.vaultRoot);
    const exists = fileExists(env.filePath);
    const compileArgs = exists
      ? { mainFilePath: env.filePath }
      : { mainFileContent: source };

    let pages: RenderedPage[] = [];
    let markers: MarkerPosition[] = [];
    let diagnostics: RenderDiagnostic[] = [];
    let svgBytes = 0;

    try {
      if (exists) compiler.addSource(env.filePath, source);
      const compiled = compiler.compile(compileArgs);
      const failed = compiled.hasError() || !compiled.result;

      if (failed) {
        diagnostics = this.diagnosticsFor(compiler, compiled, source, env, true);
      } else {
        // 1. Rich SVG from the clean source.
        const svg = compiler.svg(compileArgs);
        svgBytes = svg.length;
        pages = splitSvgIntoPages(svg);
        // 2. Marker positions from the instrumented source.
        if (exists) compiler.addSource(env.filePath, instrument(source, blocks));
        const rawMarkers = compiler.query(
          compileArgs,
          { selector: 'metadata', field: 'value' },
        );
        markers = parseMarkers(rawMarkers, blocks.length + 1);
        if (exists) compiler.addSource(env.filePath, source);
      }
    } catch (error) {
      diagnostics = [
        {
          severity: 'error',
          message: error instanceof Error ? error.message : String(error),
          hints: [],
        },
      ];
    }

    const renderMs = performance.now() - started;
    const result: RenderResult = {
      language: this.id,
      blocks,
      pages,
      boxes: buildGeometry(blocks, markers, pages),
      diagnostics,
      outline: outlineOf(blocks),
      stats: { renderMs, svgBytes, revision: ++this.revision },
    };

    this.cache.set(cacheKey, result);
    while (this.cache.size > RENDER_CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return result;
  }

  async pdf(source: string, env: AdapterEnv): Promise<Uint8Array> {
    const compiler = this.compilerFor(env.vaultRoot);
    if (fileExists(env.filePath)) compiler.addSource(env.filePath, source);
    const args = fileExists(env.filePath)
      ? { mainFilePath: env.filePath }
      : { mainFileContent: source };
    return new Uint8Array(compiler.pdf(args));
  }

  private diagnosticsFor(
    compiler: NodeCompiler,
    compiled: ReturnType<NodeCompiler['compile']>,
    source: string,
    env: AdapterEnv,
    withCli: boolean,
  ): RenderDiagnostic[] {
    const diagnostics: RenderDiagnostic[] = [];
    try {
      const taken = compiled.takeDiagnostics();
      const short = taken?.shortDiagnostics ?? [];
      for (const entry of short as Array<Record<string, unknown>>) {
        const message = String(entry.message ?? 'compile error');
        const severity = Number(entry.severity ?? 1) === 1 ? 'error' : 'warning';
        diagnostics.push({ severity, message, hints: [] });
      }
    } catch {
      /* ignore */
    }
    if (withCli && this.cliDiagnostics) {
      const fromCli = runCliDiagnostics(env.vaultRoot, env.filePath, source);
      if (fromCli.length > 0) {
        return fromCli.map((entry) => {
          const offset = lineColumnToOffset(source, entry.line, entry.column);
          return {
            severity: entry.severity,
            message: entry.message,
            range: { from: offset, to: Math.min(source.length, offset + 1) },
            hints: [],
          } satisfies RenderDiagnostic;
        });
      }
    }
    return diagnostics;
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

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

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
