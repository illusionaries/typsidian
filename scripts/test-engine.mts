/**
 * Typst engine test suite.
 *
 * Run with `npx tsx scripts/test-engine.mts`.
 *
 * Kept dependency free (no test runner): the whole suite has to stay fast
 * (<10s) and usable while iterating on the engine. It covers:
 *
 *  1. block splitting (native parser + heuristic fallback),
 *  2. layout neutrality of the geometry instrumentation,
 *  3. adapter rendering: pages, boxes, hit-test geometry,
 *  4. ranged diagnostics from the local `typst` CLI,
 *  5. unsaved sibling imports (env.files overlays),
 *  6. render caching.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

import type { AdapterEnv, DocBlock, RenderResult } from '../shared/doc';
import { nativeParserPath, splitBlocks } from '../server/engine/typst/native-parser';
import { instrument } from '../server/engine/typst/markers';
import { splitTypstBlocks } from '../server/engine/typst/blocks';
import { runCliDiagnostics } from '../server/engine/typst/adapter-diagnostics';
import { TypstAdapter } from '../server/engine/typst/adapter';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = path.join(ROOT, 'sample-vault');
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'typsidian-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const started = performance.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${Math.round(performance.now() - started)}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL ${name}`);
    console.log(
      message
        .split('\n')
        .map((line) => `       ${line}`)
        .join('\n'),
    );
  }
}

/** A scratch workspace for direct compiler experiments. */
function scratchDir(name: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const compilers = new Map<string, NodeCompiler>();
function compilerFor(dir: string): NodeCompiler {
  const existing = compilers.get(dir);
  if (existing) return existing;
  const compiler = NodeCompiler.create({
    workspace: dir,
    fontArgs: [{ fontPaths: FONT_PATHS }],
  });
  compilers.set(dir, compiler);
  return compiler;
}

let scratchCounter = 0;
/** Compile `source` in a scratch workspace and return rendered SVG markup. */
function compileSvg(source: string, dir: string, plain = false): string {
  const compiler = compilerFor(dir);
  const file = path.join(dir, `doc-${scratchCounter++}.typ`);
  compiler.mapShadow(file, Buffer.from(source));
  try {
    return plain ? compiler.plainSvg({ mainFilePath: file }) : compiler.svg({ mainFilePath: file });
  } finally {
    compiler.unmapShadow(file);
  }
}

/**
 * Drop `<g>` wrappers that do not affect rendering.
 *
 * Typst's SVG exporter inserts an extra, attribute-less group around content
 * that follows a `context` expression (our marker lines). The nested group has
 * no transform, fill or clip, so it cannot change what is painted; removing it
 * lets the comparison stay exact for everything that *can* change rendering
 * (transforms, paths, text positions, colors).
 */
function flattenInertGroups(svg: string): string {
  const out: string[] = [];
  const stack: boolean[] = [];
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt < 0) {
      out.push(svg.slice(i));
      break;
    }
    out.push(svg.slice(i, lt));
    const gt = svg.indexOf('>', lt);
    if (gt < 0) {
      out.push(svg.slice(lt));
      break;
    }
    const tag = svg.slice(lt, gt + 1);
    if (/^<g[\s>]/.test(tag)) {
      // `<g>` and `<g class="typst-group">` are pure containers.
      const inert = /^<g(?:\s+class="typst-group")?\s*>$/.test(tag);
      if (!inert) out.push(tag);
      stack.push(inert);
    } else if (tag === '</g>') {
      if (!stack.pop()) out.push(tag);
    } else {
      out.push(tag);
    }
    i = gt + 1;
  }
  // Only the tag structure matters; indentation changes when wrappers go away.
  return out.join('').replace(/>\s+</g, '><');
}

/**
 * Canonical *plain* SVG: strips source-position attributes and inert group
 * wrappers, then collapses inter-tag whitespace. Plain SVG paint operations are
 * a direct function of layout, so a byte-identical result is a strong layout
 * neutrality assertion.
 */
function canonicalPlainSvg(svg: string): string {
  return flattenInertGroups(svg.replace(/\sdata-tid="[^"]*"/g, ''));
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function parseTransform(value: string | null): Matrix {
  if (!value) return IDENTITY;
  let matrix: Matrix = IDENTITY;
  const pattern = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (match[1] === 'translate') {
      matrix = multiply(matrix, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
    } else if (match[1] === 'scale') {
      matrix = multiply(matrix, [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]);
    } else if (match[1] === 'matrix' && args.length === 6) {
      matrix = multiply(matrix, args as Matrix);
    }
    // Rotations are not emitted by Typst's exporter; ignore unknown forms.
  }
  return matrix;
}

/**
 * Geometry signature of the *rich* SVG used by the UI.
 *
 * The rich exporter wraps content in groups that are derived from the source
 * map (content hints, selection overlays, context wrappers), so its markup can
 * legitimately differ even when nothing moves. Instead of comparing markup we
 * compare every painted element with its *accumulated* transform matrix: if the
 * sequence of draw operations and their absolute geometry is identical, the
 * instrumentation cannot have changed the layout.
 */
/** Stable short hash for content comparison. */
function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

interface DrawOp {
  op: string;
  matrix: number[];
  attrs: string;
}

function richGeometrySignature(svg: string): DrawOp[] {
  const records: DrawOp[] = [];
  // Glyph ids are assigned from an internal render cache and are *not* stable
  // across compiles, so map them back to the outlined path they refer to.
  const glyphPaths = new Map<string, string>();
  const glyphs = svg.match(/<defs class="glyph">([\s\S]*?)<\/defs>/);
  if (glyphs) {
    for (const path of glyphs[1].match(/<[^>]+\/>/g) ?? []) {
      const id = /\bid="([^"]*)"/.exec(path)?.[1];
      const d = /\bd="([^"]*)"/.exec(path)?.[1];
      if (id && d) glyphPaths.set(id, d);
    }
    for (const d of [...glyphPaths.values()].sort()) {
      records.push({ op: 'glyph', matrix: [], attrs: hashText(d) });
    }
  }
  const stack: Array<{ transform: Matrix; skip: boolean }> = [];
  const skipTags = new Set(['style', 'defs', 'foreignObject']);
  const tokenPattern = /<[^>]+>/g;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(svg))) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      depth--;
      stack.pop();
      continue;
    }
    const nameMatch = /^<\s*([A-Za-z0-9:_-]+)/.exec(tag);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const selfClosing = /\/>$/.test(tag);
    const closing = /^<\/\s*([A-Za-z0-9:_-]+)\s*>$/.exec(tag);
    const attributes = (attributeName: string): string | null => {
      const found = new RegExp(`\\b${attributeName}="([^"]*)"`).exec(tag);
      return found ? found[1] : null;
    };
    const top = stack[stack.length - 1];
    const parentTransform = top ? top.transform : IDENTITY;
    const parentSkip = top ? top.skip : false;
    const transform = multiply(parentTransform, parseTransform(attributes('transform')));
    void closing;
    if (name === 'g' || name === 'svg') {
      const skip = parentSkip || skipTags.has(name) || /class="typst-content-hint"/.test(tag);
      stack.push({ transform, skip });
      depth++;
      continue;
    }
    const skip = parentSkip || skipTags.has(name);
    if (!skip) {
      const matrix = transform.map((value) => Math.round(value * 1000) / 1000);
      const attrNames = ['x', 'y', 'width', 'height', 'fill', 'fill-rule', 'stroke', 'd', 'class'];
      const attrs = attrNames
        .map((attributeName) => {
          const value = attributes(attributeName);
          return value == null ? '' : `${attributeName}=${value}`;
        })
        .filter(Boolean);
      const href = attributes('href') ?? attributes('xlink:href');
      if (href && href.startsWith('#')) {
        const glyph = glyphPaths.get(href.slice(1));
        attrs.push(`glyph=${glyph == null ? href : hashText(glyph)}`);
      }
      if (name === 'use' || name === 'path' || name === 'rect' || name === 'image' || name === 'text' || /typst-text/.test(tag)) {
        records.push({ op: name, matrix, attrs: attrs.join(' ') });
      }
    }
    if (!selfClosing) {
      stack.push({ transform, skip });
      depth++;
    }
  }
  return records;
}

function docBlocks(source: string, split: (source: string) => DocBlock[], label: string): void {
  const blocks = split(source);
  assert.ok(blocks.length > 0 || source.trim() === '', `${label}: expected blocks`);
  let previousEnd = -1;
  let coveredContent = false;
  for (const block of blocks) {
    assert.ok(block.range.from >= 0 && block.range.to <= source.length, `${label}: range out of bounds`);
    assert.ok(block.range.to > block.range.from, `${label}: empty block ${block.id}`);
    assert.ok(block.range.from >= previousEnd, `${label}: overlapping blocks at ${block.id}`);
    assert.equal(source.slice(block.range.from, block.range.to), block.text, `${label}: text mismatch`);
    previousEnd = block.range.to;
    if (block.text.trim() !== '') coveredContent = true;
  }
  // Everything between two blocks must be whitespace, so no content is lost.
  let cursor = 0;
  for (const block of blocks) {
    const gap = source.slice(cursor, block.range.from);
    assert.equal(gap.trim(), '', `${label}: non-whitespace gap ${JSON.stringify(gap)} before ${block.id}`);
    cursor = block.range.to;
  }
  assert.equal(source.slice(cursor).trim(), '', `${label}: non-whitespace tail after last block`);
  if (source.trim() !== '') assert.ok(coveredContent, `${label}: no content covered`);
}

// ---------------------------------------------------------------------------
// 1. Block splitting
// ---------------------------------------------------------------------------

console.log('\nblocks');

const SAMPLE_DOCS = ['welcome.typ', 'showcase.typ', path.join('notes', 'ideas.typ')];
const edgeDocs: Array<[string, string]> = [
  ['empty', ''],
  ['blank', '\n\n\n'],
  ['comment-only', '// just a comment\n'],
  ['leading-comment', '// intro\n= Hello\n\nText\n'],
  ['unicode', '= Héllo — 世界\n\nSome ⌘ text with `raw` and $x^2$.\n'],
  ['list-blank-lines', '- a\n\n- b\n\n- c\n'],
  ['statements', '#set page(margin: 1cm)\n#set text(size: 10pt)\n\nText\n'],
  ['no-final-newline', '= Head\nLast line'],
  ['nested-code', '#let f(x) = {\n  let y = x + 1\n  y * 2\n}\n\n#f(2)\n'],
  ['raw-fence', '```typ\n#let x = 1\n```\n'],
  ['shebang', '#!/usr/bin/env typst\n= Hi\n\nText\n'],
  ['crlf', '= Hi\r\n\r\nText line one.\r\nText line two.\r\n'],
  ['tabs-and-nesting', '= Hi\n\n\tIndented text\n\n- a\n\t- nested\n'],
];

for (const doc of SAMPLE_DOCS) {
  await test(`native blocks cover ${doc}`, () => {
    docBlocks(fs.readFileSync(path.join(VAULT, doc), 'utf8'), splitBlocks, doc);
  });
}
for (const [name, source] of edgeDocs) {
  await test(`native blocks cover edge doc: ${name}`, () => {
    docBlocks(source, splitBlocks, name);
  });
}

await test('heuristic fallback produces valid blocks', () => {
  for (const doc of SAMPLE_DOCS) {
    docBlocks(fs.readFileSync(path.join(VAULT, doc), 'utf8'), splitTypstBlocks, doc);
  }
  for (const [name, source] of edgeDocs) docBlocks(source, splitTypstBlocks, name);
});

await test('native and heuristic agree on content coverage', () => {
  for (const doc of SAMPLE_DOCS) {
    const source = fs.readFileSync(path.join(VAULT, doc), 'utf8');
    const native = splitBlocks(source);
    const heuristic = splitTypstBlocks(source);
    const kinds = (blocks: DocBlock[]) => blocks.map((block) => block.kind).sort();
    // Kinds may differ (the native parser knows about tables/figures/quotes),
    // but both split the same document into a comparable number of blocks.
    assert.ok(Math.abs(native.length - heuristic.length) <= 3, `${doc}: ${native.length} vs ${heuristic.length}`);
    assert.ok(kinds(native).length === native.length);
  }
});

// ---------------------------------------------------------------------------
// 2. Instrumentation must be layout neutral
// ---------------------------------------------------------------------------

console.log('\ninstrumentation');

async function assertNeutral(label: string, source: string): Promise<void> {
  const blocks = splitBlocks(source);
  const marked = instrument(source, blocks);
  const dir = scratchDir(`neutral-${label.replace(/[^a-z0-9-]/gi, '_')}`);
  const plainClean = canonicalPlainSvg(compileSvg(source, dir, true));
  const plainMarked = canonicalPlainSvg(compileSvg(marked, dir, true));
  assert.equal(plainMarked, plainClean, `${label}: plain SVG changed by instrumentation`);
  const richClean = richGeometrySignature(compileSvg(source, dir, false));
  const richMarked = richGeometrySignature(compileSvg(marked, dir, false));
  assert.equal(richMarked.length, richClean.length, `${label}: number of draw ops changed`);
  for (let index = 0; index < richClean.length; index++) {
    const clean = richClean[index];
    const marked = richMarked[index];
    const closeEnough =
      clean.op === marked.op &&
      clean.attrs === marked.attrs &&
      clean.matrix.length === marked.matrix.length &&
      clean.matrix.every((value, axis) => Math.abs(value - marked.matrix[axis]) <= 0.02);
    if (!closeEnough) {
      throw new Error(
        `${label}: rich SVG geometry changed at draw op ${index}/${richClean.length}` +
          `\n  clean : ${clean.op} @${clean.matrix.join(',')} ${clean.attrs.slice(0, 240)}` +
          `\n  marked: ${marked.op} @${marked.matrix.join(',')} ${marked.attrs.slice(0, 240)}`,
      );
    }
  }
}

for (const doc of SAMPLE_DOCS) {
  await test(`layout-neutral instrumentation: ${doc}`, async () => {
    await assertNeutral(doc, fs.readFileSync(path.join(VAULT, doc), 'utf8'));
  });
}
for (const [name, source] of edgeDocs) {
  if (source.trim() === '') continue;
  await test(`layout-neutral instrumentation: ${name}`, async () => {
    await assertNeutral(name, source);
  });
}

await test('layout-neutral instrumentation (heuristic fallback)', async () => {
  for (const doc of SAMPLE_DOCS) {
    const source = fs.readFileSync(path.join(VAULT, doc), 'utf8');
    const marked = instrument(source, splitTypstBlocks(source));
    const dir = scratchDir(`neutral-heuristic-${doc.replace(/[^a-z0-9-]/gi, '_')}`);
    assert.equal(
      canonicalPlainSvg(compileSvg(marked, dir, true)),
      canonicalPlainSvg(compileSvg(source, dir, true)),
      `${doc}: heuristic instrumentation changed layout`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Adapter rendering: pages, boxes, hit-testing geometry
// ---------------------------------------------------------------------------

console.log('\nadapter');

const adapter = new TypstAdapter();
const adapterVault = scratchDir('adapter-vault');

function adapterEnv(filePath: string, files: Record<string, string> = {}): AdapterEnv {
  return { filePath, vaultRoot: adapterVault, files };
}

function sampleEnv(doc: string): AdapterEnv {
  return { filePath: path.join(VAULT, doc), vaultRoot: VAULT, files: {} };
}

function assertBoxesInBounds(result: RenderResult): void {
  assert.equal(result.boxes.length, result.blocks.length, 'one box per block');
  const pageById = new Map(result.pages.map((page) => [page.index, page]));
  for (const box of result.boxes) {
    assert.ok(box.rects.length > 0, `block ${box.blockId} has no rects`);
    for (const rect of box.rects) {
      const page = pageById.get(rect.page);
      assert.ok(page, `block ${box.blockId}: rect on unknown page ${rect.page}`);
      assert.ok(rect.x >= -0.01, `${box.blockId}: x < 0 on page ${rect.page}`);
      assert.ok(rect.y >= -0.01, `${box.blockId}: y < 0 on page ${rect.page}`);
      assert.ok(rect.width > 0, `${box.blockId}: empty width`);
      assert.ok(rect.height > 0, `${box.blockId}: empty height`);
      assert.ok(rect.x + rect.width <= page!.widthPt + 0.01, `${box.blockId}: overflows page width`);
      assert.ok(rect.y + rect.height <= page!.heightPt + 0.01, `${box.blockId}: overflows page height`);
    }
    // No rect may start before the previous one ends on the same page. Blocks
    // that produce no output (e.g. `#set` runs) collapse to a 1pt box, so a
    // small tolerance is allowed.
    const sorted = [...box.rects].sort((a, b) => a.y - b.y);
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      if (previous.page !== sorted[index].page) continue;
      assert.ok(
        sorted[index].y >= previous.y + previous.height - 2,
        `${box.blockId}: overlapping rects on page ${previous.page}`,
      );
    }
  }
}

let sampleRenders: Array<[string, RenderResult]> = [];

await test('renders sample documents', async () => {
  sampleRenders = [];
  for (const doc of SAMPLE_DOCS) {
    const source = fs.readFileSync(path.join(VAULT, doc), 'utf8');
    const result = await adapter.render(source, sampleEnv(doc));
    sampleRenders.push([doc, result]);
    assert.equal(result.language, 'typst');
    assert.ok(result.pages.length > 0, `${doc}: no pages`);
    assert.ok(result.blocks.length > 0, `${doc}: no blocks`);
    assert.ok(result.stats.svgBytes > 0, `${doc}: no svg bytes`);
    assert.equal(result.pages.length, new Set(result.pages.map((page) => page.index)).size);
    for (const page of result.pages) {
      assert.ok(page.svg.startsWith('<svg'), `${doc}: page ${page.index} is not svg`);
      assert.ok(page.svg.includes('viewBox="0 0 '), `${doc}: page ${page.index} lacks viewBox`);
      assert.ok(page.widthPt > 100 && page.heightPt > 100, `${doc}: bad page size`);
    }
    // Outline mirrors the heading blocks.
    const headings = result.blocks.filter((block) => block.kind === 'heading');
    assert.equal(result.outline.length, headings.length, `${doc}: outline mismatch`);
  }
});

await test('boxes stay inside their pages and do not overlap', () => {
  for (const [doc, result] of sampleRenders) {
    try {
      assertBoxesInBounds(result);
    } catch (error) {
      throw new Error(`${doc}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

await test('multi-page document yields boxes on every page', async () => {
  const source = `= Long document\n\n${'#lorem(60)\n\n'.repeat(14)}`;
  const result = await adapter.render(source, adapterEnv(path.join(adapterVault, 'long.typ')));
  assert.ok(result.pages.length >= 2, `expected multiple pages, got ${result.pages.length}`);
  const pagesWithBoxes = new Set(result.boxes.flatMap((box) => box.rects.map((rect) => rect.page)));
  for (let page = 0; page < result.pages.length; page++) {
    assert.ok(pagesWithBoxes.has(page), `page ${page} has no block boxes`);
  }
  assertBoxesInBounds(result);
});

await test('column layouts get column-local boxes', async () => {
  const source = `#set page(columns: 2, paper: "a4")\n#set par(justify: true)\n\n${'#lorem(250)\n\n'.repeat(4)}`;
  const result = await adapter.render(source, adapterEnv(path.join(adapterVault, 'columns.typ')));
  assert.ok(result.pages.length >= 1);
  assertBoxesInBounds(result);
  const xs = [...new Set(result.boxes.flatMap((box) => box.rects.map((rect) => rect.x)))].sort((a, b) => a - b);
  assert.ok(xs.length >= 2, `expected two columns, got x positions ${JSON.stringify(xs)}`);
  const rightColumn = result.boxes.find((box) => box.rects.some((rect) => rect.x > result.pages[0].widthPt / 2));
  assert.ok(rightColumn, 'no block landed in the right column');
  // Right-column boxes must not span the whole page width.
  const rightRect = rightColumn!.rects.find((rect) => rect.x > result.pages[0].widthPt / 2)!;
  assert.ok(rightRect.width < result.pages[0].widthPt * 0.6, `right column box too wide: ${rightRect.width}`);
});

await test('rendering never throws on broken input', async () => {
  const broken: Array<[string, string]> = [
    ['syntax', '#let x = }\n'],
    ['missing-import', '#import "does-not-exist.typ": thing\n'],
    ['unterminated', '#table(columns: 2, [a]\n'],
    ['empty', ''],
  ];
  for (const [name, source] of broken) {
    const result = await adapter.render(source, adapterEnv(path.join(adapterVault, `${name}.typ`)));
    assert.ok(Array.isArray(result.pages), `${name}: no pages array`);
    assert.ok(Array.isArray(result.blocks), `${name}: no blocks array`);
    assert.ok(Array.isArray(result.diagnostics), `${name}: no diagnostics array`);
    if (source.trim() !== '') {
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), `${name}: no error diagnostic`);
      assert.ok(result.blocks.length > 0, `${name}: blocks must survive a failed compile`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Ranged diagnostics
// ---------------------------------------------------------------------------

console.log('\ndiagnostics');

await test('error diagnostics carry source ranges', async () => {
  const source = '#let x = 1\n#x.nope\n';
  const result = await adapter.render(source, adapterEnv(path.join(adapterVault, 'error.typ')));
  const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  assert.ok(error, 'no error diagnostic');
  assert.ok(error.range, 'error diagnostic has no range');
  assert.ok(error.range.from >= 0 && error.range.to <= source.length, 'range out of bounds');
  const text = source.slice(error.range.from, error.range.to);
  assert.ok(text.includes('x.nope') || text.includes('nope') || text === 'x', `range covers ${JSON.stringify(text)}`);
});

await test('ranges use UTF-16 offsets (astral prefix)', async () => {
  const source = 'Hi 😀🎉 #nope\n';
  const result = await adapter.render(source, adapterEnv(path.join(adapterVault, 'emoji.typ')));
  const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  assert.ok(error?.range, 'no ranged error');
  assert.equal(source.slice(error.range.from, error.range.to), 'nope');
});

await test('warnings are included and ranged', async () => {
  const source = '#set text(font: "Definitely Not A Font")\n= Hello\n\nBody.\n';
  const result = await adapter.render(source, adapterEnv(path.join(adapterVault, 'warning.typ')));
  const warning = result.diagnostics.find((diagnostic) => diagnostic.severity === 'warning');
  assert.ok(warning, 'no warning diagnostic');
  assert.ok(warning.message.includes('unknown font family'), `unexpected warning: ${warning.message}`);
  assert.ok(warning.range, 'warning has no range');
  assert.ok(result.pages.length > 0, 'warnings must not block rendering');
});

await test('CLI fallback provides ranged diagnostics', async () => {
  const probe = spawnSync('typst', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('       (skipped: typst CLI not on PATH)');
    return;
  }
  const source = '#let x = 1\n#x.nope\n';
  const result = await runCliDiagnostics(
    'cli-fallback-test-key',
    source,
    adapterEnv(path.join(adapterVault, 'cli-error.typ')),
    { fontPaths: FONT_PATHS },
  );
  assert.ok(result.available, 'typst CLI reported unavailable');
  const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  assert.ok(error, 'CLI produced no error');
  assert.ok(error.range, 'CLI diagnostic has no range');
  assert.ok(error.range.from >= 0 && error.range.to <= source.length, 'CLI range out of bounds');
  // The short format only carries a start position; it must point into the
  // second line, where the error is.
  assert.equal(source.slice(0, error.range.from).split('\n').length, 2, 'CLI range points to the wrong line');

  // Unsaved siblings must resolve in the shadow workspace the CLI compiles.
  const overlay = await runCliDiagnostics(
    'cli-fallback-overlay-test-key',
    '#import "sib.typ": hi\n#hi()\n',
    adapterEnv(path.join(adapterVault, 'cli-overlay.typ'), {
      'sib.typ': '#let hi() = [Hello]\n',
    }),
    { fontPaths: FONT_PATHS },
  );
  assert.deepEqual(overlay.diagnostics, [], 'CLI reported a false error for an unsaved sibling import');
});

await test('errors inside imports are reported with the file name', async () => {
  const source = '#import "broken.typ": x\n#x\n';
  const result = await adapter.render(
    source,
    adapterEnv(path.join(adapterVault, 'importer.typ'), {
      'broken.typ': '#let x = 1\n#x.nope\n',
    }),
  );
  assert.ok(result.diagnostics.length > 0, 'no diagnostics from imported file');
  const text = result.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
  assert.ok(text.includes('broken.typ'), `diagnostics do not mention the imported file: ${text}`);
});

// ---------------------------------------------------------------------------
// 5. Unsaved sibling imports (env.files overlays)
// ---------------------------------------------------------------------------

console.log('\nmulti-file');

await test('unsaved main file can import an unsaved sibling', async () => {
  const result = await adapter.render(
    '#import "sib.typ": hi\n#hi()\n',
    adapterEnv(path.join(adapterVault, 'unsaved-main.typ'), {
      'sib.typ': '#let hi() = [Hello from the overlay]\n',
    }),
  );
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), 'unexpected errors');
  assert.ok(result.pages.length > 0, 'no pages');
  assert.ok(result.stats.svgBytes > 0, 'no svg');
});

await test('unsaved buffer overlays shadow on-disk siblings', async () => {
  const dir = scratchDir('overlay-vault');
  fs.writeFileSync(path.join(dir, 'sib.typ'), '#let word = "disk"\n');
  const env = (files: Record<string, string>): AdapterEnv => ({
    filePath: path.join(dir, 'main.typ'),
    vaultRoot: dir,
    files,
  });
  const source = '#import "sib.typ": word\n#word\n';
  const disk = await adapter.render(source, env({}));
  const overlay = await adapter.render(source, env({ 'sib.typ': '#let word = "overlay text"\n' }));
  assert.notEqual(
    overlay.pages.map((page) => page.svg).join(''),
    disk.pages.map((page) => page.svg).join(''),
    'overlay content did not reach the compiler',
  );
  assert.ok(overlay.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), 'overlay import failed');
  // Switching back to the disk version must not leak the previous overlay.
  const diskAgain = await adapter.render(source, env({ 'sib.typ': '#let word = "disk"\n' }));
  assert.ok(diskAgain.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), 'stale overlay leaked');
});

// ---------------------------------------------------------------------------
// 6. Caching + PDF + parser entry points
// ---------------------------------------------------------------------------

console.log('\ncaching');

await test('unchanged documents hit the render cache', async () => {
  const source = fs.readFileSync(path.join(VAULT, 'showcase.typ'), 'utf8');
  const env = sampleEnv('showcase.typ');
  const first = await adapter.render(source, env);
  const started = performance.now();
  const second = await adapter.render(source, env);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60, `cache hit took ${Math.round(elapsed)}ms`);
  assert.equal(second.pages.length, first.pages.length);
  assert.deepEqual(
    second.blocks.map((block) => block.id),
    first.blocks.map((block) => block.id),
  );
  assert.ok(second.stats.revision > first.stats.revision, 'revision should increase');
});

await test('pdf export works', async () => {
  const source = '#set page(paper: "a5")\n= Hello\n\nBody.\n';
  const bytes = await adapter.pdf(source, adapterEnv(path.join(adapterVault, 'pdf.typ')));
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString('latin1'), '%PDF');
});

await test('adapter.parse and the native parser agree', async () => {
  const source = fs.readFileSync(path.join(VAULT, 'welcome.typ'), 'utf8');
  const parsed = await adapter.parse(source);
  const direct = splitBlocks(source);
  assert.deepEqual(parsed.map((block) => block.id), direct.map((block) => block.id));
  if (process.env.TYPSIDIAN_DISABLE_NATIVE !== '1' && process.env.TYPSIDIAN_FORCE_TS_SPLITTER !== '1') {
    assert.ok(nativeParserPath(), 'native parser binary not found');
  }
});

// ---------------------------------------------------------------------------
// 7. renderBlock
// ---------------------------------------------------------------------------

console.log('\nblock rendering');

/** Expected clipped/padded viewBox for a rect on a page. */
function expectedViewBox(
  rect: { x: number; y: number; width: number; height: number; page: number },
  page: { widthPt: number; heightPt: number },
): { left: number; top: number; width: number; height: number } {
  const padding = 4;
  const left = Math.max(0, rect.x - padding);
  const top = Math.max(0, rect.y - padding);
  const right = Math.min(page.widthPt, rect.x + rect.width + padding);
  const bottom = Math.min(page.heightPt, rect.y + rect.height + padding);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function parseViewBox(html: string): number[] | null {
  const match = /viewBox="([^"]*)"/.exec(html);
  if (!match) return null;
  return match[1].trim().split(/\s+/).map(Number);
}

await test('capabilities advertise block rendering', () => {
  assert.equal(adapter.capabilities.blockRendering, true);
});

await test('renderBlock returns a standalone SVG matching the geometry', async () => {
  const source = fs.readFileSync(path.join(VAULT, 'welcome.typ'), 'utf8');
  const env = sampleEnv('welcome.typ');
  const result = await adapter.render(source, env);
  const heading = result.blocks.find((block) => block.kind === 'heading' && block.level === 1);
  assert.ok(heading, 'no level-1 heading');
  const rendered = await adapter.renderBlock(heading!, source, env);
  assert.equal(rendered.blockId, heading!.id);
  assert.ok(rendered.html, 'renderBlock returned no html');
  assert.ok(rendered.html!.startsWith('<svg'), 'block html is not an svg');
  const box = result.boxes.find((candidate) => candidate.blockId === heading!.id);
  assert.ok(box && box.rects.length > 0, 'heading has no box');
  assert.deepEqual(rendered.rects, box!.rects);
  const rect = box!.rects[0];
  const page = result.pages.find((candidate) => candidate.index === rect.page)!;
  const expected = expectedViewBox(rect, page);
  const viewBox = parseViewBox(rendered.html!);
  assert.ok(viewBox, 'block svg has no viewBox');
  for (let axis = 0; axis < 4; axis++) {
    const target = [expected.left, expected.top, expected.width, expected.height][axis];
    assert.ok(
      Math.abs(viewBox![axis] - target) < 0.2,
      `viewBox[${axis}] = ${viewBox![axis]}, expected ${target}`,
    );
  }
});

await test('renderBlock works for a block on the second page', async () => {
  const source = `= Long document\n\n${'#lorem(60)\n\n'.repeat(14)}`;
  const env = adapterEnv(path.join(adapterVault, 'long-block.typ'));
  const result = await adapter.render(source, env);
  assert.ok(result.pages.length >= 2, 'need multiple pages');
  // `renderBlock` slices the block's *first* rect, so pick a block that
  // starts on the second page.
  const boxOnSecond = result.boxes.find((box) => box.rects[0]?.page === 1);
  assert.ok(boxOnSecond, 'no block starting on the second page');
  const onSecond = result.blocks.find((block) => block.id === boxOnSecond!.blockId);
  assert.ok(onSecond, 'block for second-page box missing');
  const rendered = await adapter.renderBlock(onSecond!, source, env);
  assert.ok(rendered.html?.startsWith('<svg'), 'no svg for second-page block');
  const box = boxOnSecond!;
  const rect = box.rects[0];
  const page = result.pages[1];
  const expected = expectedViewBox(rect, page);
  const viewBox = parseViewBox(rendered.html!);
  assert.ok(viewBox, 'no viewBox');
  assert.ok(Math.abs(viewBox![0] - expected.left) < 0.2 && Math.abs(viewBox![1] - expected.top) < 0.2, 'wrong viewBox origin');
  assert.ok(viewBox![2] > 0 && viewBox![3] > 0, 'empty viewBox');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
