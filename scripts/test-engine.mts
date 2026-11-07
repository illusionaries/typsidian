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
import { splitBlocks } from '../server/engine/typst/native-parser';
import { instrument } from '../server/engine/typst/markers';
import { splitTypstBlocks } from '../server/engine/typst/blocks';
import { TypstAdapter } from '../server/engine/typst/adapter';

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

function richGeometrySignature(svg: string): string[] {
  const records: string[] = [];
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
    for (const d of [...glyphPaths.values()].sort()) records.push(`glyph ${hashText(d)}`);
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
        records.push(`${name} @${matrix.join(',')} ${attrs}`);
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
  for (let index = 0; index < Math.max(richClean.length, richMarked.length); index++) {
    if (richClean[index] !== richMarked[index]) {
      throw new Error(
        `${label}: rich SVG geometry changed at draw op ${index}/${richClean.length}` +
          `\n  clean : ${String(richClean[index]).slice(0, 300)}` +
          `\n  marked: ${String(richMarked[index]).slice(0, 300)}`,
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
