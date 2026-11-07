/**
 * Parser-backed block splitter.
 *
 * The heavy lifting happens in a tiny Rust binary (`native/`, `typst-syntax`)
 * which parses the document with the *real* Typst parser and reports top-level
 * block boundaries as JSON. Parsing with the actual grammar is what makes the
 * geometry instrumentation safe: the adapter may only insert an invisible
 * marker line in front of a block, so block boundaries have to line up with
 * syntactic construct boundaries (`= heading`, a list group, a fenced raw
 * block, a display equation, a paragraph break, ...) rather than with a
 * hand-written heuristic.
 *
 * Every failure mode (binary not built, crashed, garbage output) falls back to
 * the heuristic splitter in `blocks.ts`, so a checkout without a Rust toolchain
 * still works.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { BlockKind, DocBlock } from '../../../shared/doc';
import { makeDocBlock, splitTypstBlocks } from './blocks';

/** A block as reported by the native parser. Offsets are UTF-16 indices. */
export interface NativeBlockSpec {
  from: number;
  to: number;
  kind: BlockKind;
  level?: number;
}

const BINARY_NAME =
  process.platform === 'win32' ? 'typsidian-parser.exe' : 'typsidian-parser';

/** Root of this checkout, derived from the module location (server/engine/typst). */
function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

function candidateBinaries(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.TYPSIDIAN_TYPST_PARSER;
  if (fromEnv) candidates.push(fromEnv);
  const root = projectRoot();
  candidates.push(
    path.join(root, 'native', 'target', 'release', BINARY_NAME),
    path.join(root, 'native', 'target', 'debug', BINARY_NAME),
  );
  return candidates;
}

/** `undefined` = not resolved yet, `null` = unavailable. */
let resolvedBinary: string | null | undefined;

function binaryPath(): string | null {
  if (resolvedBinary !== undefined) return resolvedBinary;
  if (
    process.env.TYPSIDIAN_DISABLE_NATIVE === '1' ||
    process.env.TYPSIDIAN_FORCE_TS_SPLITTER === '1'
  ) {
    resolvedBinary = null;
    return null;
  }
  resolvedBinary = null;
  for (const candidate of candidateBinaries()) {
    try {
      if (fs.statSync(candidate).isFile()) {
        resolvedBinary = candidate;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return resolvedBinary;
}

/** Exposed for diagnostics / tests: which splitter is in use. */
export function nativeParserPath(): string | null {
  return binaryPath();
}

const CACHE_LIMIT = 32;
const cache = new Map<string, DocBlock[]>();

function cached(key: string): DocBlock[] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function remember(key: string, blocks: DocBlock[]): void {
  cache.set(key, blocks);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Raw parse via the native binary. Returns `null` when the binary is missing or
 * produced unusable output; never throws.
 */
function nativeBlocks(source: string): NativeBlockSpec[] | null {
  const binary = binaryPath();
  if (!binary) return null;
  try {
    const result = spawnSync(binary, ['blocks'], {
      input: source,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    const payload = JSON.parse(String(result.stdout ?? '')) as {
      ok?: boolean;
      blocks?: unknown;
    };
    if (payload?.ok !== true || !Array.isArray(payload.blocks)) return null;
    const blocks: NativeBlockSpec[] = [];
    for (const entry of payload.blocks) {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const from = record.from;
      const to = record.to;
      const kind = record.kind;
      if (typeof from !== 'number' || typeof to !== 'number') return null;
      if (typeof kind !== 'string') return null;
      if (from < 0 || to > source.length || to < from) return null;
      const level =
        typeof record.level === 'number' && record.level >= 1
          ? Math.min(6, Math.round(record.level))
          : undefined;
      blocks.push({ from, to, kind: kind as BlockKind, level });
    }
    // Boundaries must be ordered and non-overlapping; otherwise fall back.
    let previous = 0;
    for (const block of blocks) {
      if (block.from < previous) return null;
      previous = block.to;
    }
    return blocks;
  } catch {
    return null;
  }
}

/**
 * Split `source` into blocks using the native parser, falling back to the
 * heuristic splitter. Results are cached by source text so repeated parses of
 * an unchanged document never spawn a process again.
 */
export function splitBlocks(source: string): DocBlock[] {
  const hit = cached(source);
  if (hit) return hit;
  const raw = nativeBlocks(source);
  const blocks = raw
    ? raw.map((spec, ordinal) => makeDocBlock(source, spec, ordinal))
    : splitTypstBlocks(source);
  remember(source, blocks);
  return blocks;
}
