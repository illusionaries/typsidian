/**
 * Typsidian — universal document model.
 *
 * This module is the contract between languages (Typst today, Markdown and
 * others later), the rendering engine, and the three editor surfaces
 * (split source editor, visual block editor, pure preview).
 *
 * Design goals
 * ------------
 * 1. Nothing in the UI is allowed to know that "Typst" exists. The UI speaks
 *    blocks, pages, boxes, diagnostics and splices.
 * 2. A language is a plugin made of exactly two halves:
 *      - {@link DocumentAdapter}: the heavy half. Lives on the server (or in a
 *        worker), parses source into blocks and renders pages + geometry.
 *      - {@link LanguageClient}: the light half. Pure string functions and
 *        editor extensions, runs in the browser so typing never waits on I/O.
 * 3. Every interactive feature reduces to one of these primitives:
 *      - "render a block"        -> {@link RenderedBlock} / `renderBlock`
 *      - "jump to source"        -> {@link BlockBox} + `blockAtPoint`
 *      - "edit a block visually" -> {@link SourceSplice} + `spliceBlockEdit`
 *      - "show me the outline"   -> {@link OutlineItem}
 */

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

/**
 * A half-open range of the document source.
 *
 * Offsets are JavaScript string indices (UTF-16 code units) so they can be
 * handed to CodeMirror / `String.prototype.slice` directly. Adapters whose
 * native representation is byte-based are responsible for converting.
 */
export interface SourceRange {
  from: number;
  to: number;
}

/** A minimal edit: replace `[from, to)` with `insert`. */
export interface SourceSplice {
  from: number;
  to: number;
  insert: string;
}

/**
 * The kinds of blocks the universal UI understands.
 *
 * Languages map their own node types onto this small set. Anything unknown is
 * `other` and is still rendered/jumpable, it just may not get specialised
 * affordances.
 */
export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code'
  | 'math'
  | 'table'
  | 'figure'
  | 'raw'
  | 'rule'
  | 'other';

/**
 * How visual mode should let the user edit a block.
 * - `inline-text`: the block is plain text; show a caret-editable field with
 *   the syntactic decoration hidden (e.g. a heading's leading `=`).
 * - `source`: show the block's raw source in an inline mini editor.
 * - `none`: block is not editable in place (navigate to split mode instead).
 */
export type BlockEditing = 'inline-text' | 'source' | 'none';

/** One addressable unit of a document. */
export interface DocBlock {
  /** Stable within a render; derived from kind + ordinal (see `makeBlockId`). */
  id: string;
  kind: BlockKind;
  /** Exact source span of the block, decoration included. */
  range: SourceRange;
  /** Nesting depth, 0 = top level. */
  depth: number;
  /** Heading level (1..6) when `kind === 'heading'`. */
  level?: number;
  /** Short human label (heading text, first words of a paragraph, ...). */
  label: string;
  /** Plain-ish text preview used by search / outline / tooltips. */
  text: string;
  /** How visual mode edits this block. */
  editing: BlockEditing;
  /** Language specific extras (e.g. fence info, raw language). */
  meta?: Record<string, unknown>;
}

/** An action offered for a block in visual mode (bold, heading level, ...). */
export interface BlockAction {
  id: string;
  label: string;
  /** Short hint shown in the toolbar, e.g. "⌘B". */
  hint?: string;
  /** Returns the splice that applies the action, or null if not applicable. */
  run(source: string, block: DocBlock): SourceSplice | null;
}

// ---------------------------------------------------------------------------
// Rendered model
// ---------------------------------------------------------------------------

/** A rectangle in page-local points (1pt = 1/72in), origin at page top-left. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a block landed on the rendered pages. */
export interface BlockBox {
  blockId: string;
  /** One or more rects: a block can flow over lines, columns or pages. */
  rects: Array<Rect & { page: number }>;
}

/** A rendered page, self-contained and safe to inject into the DOM. */
export interface RenderedPage {
  index: number;
  widthPt: number;
  heightPt: number;
  /** SVG markup for this page only (glyph defs inlined, scripts stripped). */
  svg: string;
}

/** A render of a single block, used by visual mode for inline previews. */
export interface RenderedBlock {
  blockId: string;
  /** Page box this block occupies when rendered in document context. */
  rects: Array<Rect & { page: number }>;
  /** Optional standalone render of the block (may be empty if unsupported). */
  html?: string;
}

export interface RenderDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  range?: SourceRange;
  /** Rendered location, page-local points, when the engine provides one. */
  point?: { page: number; x: number; y: number };
  hints: string[];
}

export interface OutlineItem {
  id: string;
  blockId: string;
  depth: number;
  text: string;
  range: SourceRange;
}

export interface RenderStats {
  /** Wall-clock render time in ms, server side. */
  renderMs: number;
  /** Bytes of SVG produced. */
  svgBytes: number;
  /** Monotonic counter, useful for debugging caching. */
  revision: number;
}

/** Everything the UI needs to paint a document. */
export interface RenderResult {
  /** Language id that produced this render, e.g. "typst". */
  language: string;
  blocks: DocBlock[];
  pages: RenderedPage[];
  boxes: BlockBox[];
  diagnostics: RenderDiagnostic[];
  outline: OutlineItem[];
  stats: RenderStats;
}

// ---------------------------------------------------------------------------
// Language plugin — heavy half (server / worker)
// ---------------------------------------------------------------------------

export interface AdapterEnv {
  /** Absolute path of the file being edited. */
  filePath: string;
  /** Root of the workspace, so relative imports can be resolved. */
  vaultRoot: string;
  /** All sibling files of the vault, path -> source. */
  files: Record<string, string>;
}

export interface AdapterCapabilities {
  /** Can render a single block in isolation. */
  blockRendering: boolean;
  /** Renders into fixed pages (true for Typst, false for Markdown). */
  paginated: boolean;
  /** Supports inline-text editing of plain text blocks. */
  inlineTextEditing: boolean;
  /** Can produce a PDF export. */
  pdfExport: boolean;
}

/**
 * The heavy half of a language plugin.
 *
 * Implementations must be pure with respect to `source`: given the same source
 * and env they return the same result (internal caching is allowed).
 */
export interface DocumentAdapter {
  readonly id: string;
  readonly displayName: string;
  /** File extensions, lower case, with dot. */
  readonly extensions: readonly string[];
  readonly capabilities: AdapterCapabilities;

  /** Split source into blocks. Must not be expensive. */
  parse(source: string, env: AdapterEnv): Promise<DocBlock[]>;

  /** Full render: pages, geometry, diagnostics, outline. */
  render(source: string, env: AdapterEnv): Promise<RenderResult>;

  /**
   * Render one block on its own (used by visual mode / hover previews).
   * Optional: capabilities.blockRendering tells the UI whether to ask.
   */
  renderBlock?(
    block: DocBlock,
    source: string,
    env: AdapterEnv,
  ): Promise<RenderedBlock>;

  /** Export the whole document to PDF. Optional. */
  pdf?(source: string, env: AdapterEnv): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Language plugin — light half (browser)
// ---------------------------------------------------------------------------

/**
 * The light half of a language plugin: everything that can happen while the
 * user is typing without a server round-trip.
 */
export interface LanguageClient {
  readonly id: string;

  /** Replace a block's content, as a minimal splice. */
  spliceBlockEdit(source: string, block: DocBlock, newText: string): SourceSplice;

  /** Text to show in the inline editor for this block. */
  editableText(source: string, block: DocBlock): string;

  /** Actions offered for a block (toolbar in visual mode). */
  actions(source: string, block: DocBlock): BlockAction[];

  /**
   * CodeMirror extensions providing syntax highlighting for this language.
   * Returned as `unknown[]` so `shared/` never depends on CodeMirror types.
   */
  editorExtensions(): unknown[];

  /** Editor mode string used by the dialect indicator in the status bar. */
  readonly modeName: string;
}

// ---------------------------------------------------------------------------
// Universal operations (language agnostic)
// ---------------------------------------------------------------------------

/** Stable block id from kind and ordinal (stable across small edits). */
export function makeBlockId(kind: BlockKind, ordinal: number): string {
  return `${kind}:${ordinal}`;
}

/** The text a block currently occupies. */
export function blockText(source: string, block: DocBlock): string {
  return source.slice(block.range.from, block.range.to);
}

/** Apply a splice to a source string. */
export function applySplice(source: string, splice: SourceSplice): string {
  return source.slice(0, splice.from) + splice.insert + source.slice(splice.to);
}

/** Bounding rect of a block across pages, in page-local points. */
export function blockBounds(
  result: RenderResult,
  blockId: string,
): Array<Rect & { page: number }> {
  const box = result.boxes.find((b) => b.blockId === blockId);
  return box ? box.rects : [];
}

/**
 * Universal "click on the rendered result" -> source mapping.
 *
 * Returns the innermost (deepest) block containing the point, falling back to
 * the closest block on that page. This is the primitive behind
 * "jump to source" and click-to-edit in all three modes.
 */
export function blockAtPoint(
  result: RenderResult,
  page: number,
  x: number,
  y: number,
): DocBlock | null {
  const candidates: Array<{ block: DocBlock; area: number; distance: number }> = [];
  for (const box of result.boxes) {
    for (const rect of box.rects) {
      if (rect.page !== page) continue;
      const block = result.blocks.find((b) => b.id === box.blockId);
      if (!block) continue;
      const inside =
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height;
      const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
      const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
      const distance = Math.hypot(dx, dy);
      if (inside) {
        candidates.push({ block, area: rect.width * rect.height, distance });
      } else if (distance < 300) {
        candidates.push({ block, area: rect.width * rect.height + 1e9, distance });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    // Prefer a hit, then the smallest containing area (innermost), then distance.
    const aHit = a.area < 1e9;
    const bHit = b.area < 1e9;
    if (aHit !== bHit) return aHit ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.area - b.area;
  });
  return candidates[0].block;
}

/** The block whose source range contains `offset`, if any. */
export function blockAtOffset(blocks: DocBlock[], offset: number): DocBlock | null {
  // Deepest block wins.
  let best: DocBlock | null = null;
  for (const block of blocks) {
    if (offset >= block.range.from && offset <= block.range.to) {
      if (!best || block.depth >= best.depth) best = block;
    }
  }
  return best;
}

/** Minimal splice turning `oldText` into `newText` at `base` offset. */
export function minimalSplice(
  oldText: string,
  newText: string,
  base: number,
): SourceSplice {
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  return {
    from: base + prefix,
    to: base + oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}

/** 1-based line/column of a source offset. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: offset - lastBreak };
}
