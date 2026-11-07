/**
 * Typst block splitter.
 *
 * Typst has no explicit paragraph nodes, so we split markup into the largest
 * constructs that are *safe to instrument*: constructs that can be separated by
 * an inserted, invisible marker line without changing the parse tree or the
 * layout of the page.
 *
 * The splitter is deliberately conservative. It only breaks at
 *
 *   - top-level blank lines (paragraph / block boundaries), and
 *   - the start of a heading, list item, raw fence or display equation when the
 *     scanner is at the top level of the markup.
 *
 * While scanning we track bracket depth, string literals, comments and raw
 * fences so that a blank line inside `#let f = ( ... )`, inside `#table(...)`,
 * inside a content block `#[ ... ]` or inside a raw fence never creates a split
 * point.
 */

import type { BlockKind, DocBlock } from '../../../shared/doc';
import { makeBlockId } from '../../../shared/doc';

interface ScannerState {
  /** Bracket / paren / brace nesting depth. */
  parenDepth: number;
  inString: boolean;
  inBlockComment: boolean;
  /** Fence length of an open raw block, 0 when closed. */
  inFence: number;
}

interface Line {
  text: string;
  start: number;
  /** Offset just past the line's last character (before the newline). */
  end: number;
}

interface OpenBlock {
  from: number;
  to: number;
  kind: BlockKind;
  level?: number;
}

function freshState(): ScannerState {
  return { parenDepth: 0, inString: false, inBlockComment: false, inFence: 0 };
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source.charCodeAt(i) === 10) {
      lines.push({ text: source.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

/** Advance the scanner over one line. */
function scanLine(line: string, state: ScannerState): void {
  const fence = /^\s*(`{3,}|~{3,})/.exec(line);
  if (state.inFence > 0) {
    if (fence) state.inFence = 0;
    return;
  }
  if (fence) {
    state.inFence = fence[1].length;
    return;
  }

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        state.inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (state.inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') state.inString = false;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') return; // line comment: rest of line ignored
    if (ch === '/' && next === '*') {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      i++;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') state.parenDepth++;
    else if (ch === ')' || ch === ']' || ch === '}') state.parenDepth = Math.max(0, state.parenDepth - 1);
    i++;
  }
}

function atTopLevel(state: ScannerState): boolean {
  return state.parenDepth === 0 && !state.inString && !state.inBlockComment && state.inFence === 0;
}

function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}

const HEADING = /^(={1,6})\s+\S/;
const LIST_ITEM = /^\s*(?:[-+]|\d+[.)]|\/\s+\S+:)\s*\S?/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/** Block equation: `$ ... $` with spaces inside, alone on the line. */
const DISPLAY_MATH = /^\s*\$\s.+\s\$\s*$/;

function classify(text: string): { kind: BlockKind; level?: number } | null {
  if (isBlank(text)) return null;
  const heading = HEADING.exec(text);
  if (heading) return { kind: 'heading', level: heading[1].length };
  if (LIST_ITEM.test(text)) return { kind: 'list' };
  if (FENCE.test(text)) return { kind: 'code' };
  if (DISPLAY_MATH.test(text)) return { kind: 'math' };
  return null;
}

function blockLabel(kind: BlockKind, text: string): string {
  const firstLine = text.split('\n', 1)[0];
  if (kind === 'heading') {
    return firstLine.replace(/^\s*={1,6}\s+/, '').trim().slice(0, 120) || 'Heading';
  }
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Split Typst markup into blocks.
 *
 * Guarantees:
 *  - blocks are contiguous, trimmed and ordered;
 *  - every block starts and ends on a line boundary;
 *  - inserting a blank, invisible marker line before a block keeps the
 *    document valid and its layout unchanged.
 */
export function splitTypstBlocks(source: string): DocBlock[] {
  const lines = splitLines(source);
  const state = freshState();
  const raw: OpenBlock[] = [];
  let current: OpenBlock | null = null;
  /** A top-level blank line was seen since the last content line. */
  let blankSeen = true;

  const close = () => {
    if (current) {
      raw.push(current);
      current = null;
    }
  };
  const start = (line: Line, kind: { kind: BlockKind; level?: number } | null) => {
    current = {
      from: line.start,
      to: line.end,
      kind: kind ? kind.kind : 'paragraph',
      level: kind ? kind.level : undefined,
    };
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const topLevel = atTopLevel(state);
    const blank = isBlank(line.text);

    if (blank) {
      if (topLevel) blankSeen = true;
      scanLine(line.text, state);
      continue;
    }

    const kind = topLevel ? classify(line.text) : null;

    if (!current) {
      start(line, kind);
    } else if (!topLevel) {
      // Continuation of a construct that spans lines.
      current.to = line.end;
    } else {
      // Same list across blank lines stays one block: an inserted marker
      // between list items would split the list in two.
      const sameList = kind?.kind === 'list' && current.kind === 'list';
      const breakHere = !sameList && (blankSeen || (kind != null && startsNew(kind, current)));
      if (breakHere) {
        close();
        start(line, kind);
      } else {
        current.to = line.end;
      }
    }

    blankSeen = false;
    scanLine(line.text, state);
  }
  close();

  const blocks: DocBlock[] = [];
  let ordinal = 0;
  for (const block of raw) {
    let { from, to } = block;
    while (from < to && /[ \t]/.test(source[from])) from++;
    while (to > from && /[ \t\n]/.test(source[to - 1])) to--;
    if (to <= from) continue;
    const text = source.slice(from, to);
    blocks.push({
      id: makeBlockId(block.kind, ordinal),
      kind: block.kind,
      range: { from, to },
      depth: 0,
      level: block.level,
      label: blockLabel(block.kind, text),
      text,
      editing:
        block.kind === 'code' || block.kind === 'list' || block.kind === 'math'
          ? 'source'
          : 'inline-text',
    });
    ordinal++;
  }
  return blocks;
}

/** Whether `incoming` must start a new block even without a blank line. */
function startsNew(incoming: { kind: BlockKind }, current: OpenBlock): boolean {
  if (incoming.kind === 'heading' || incoming.kind === 'code' || incoming.kind === 'math') {
    return true;
  }
  return incoming.kind !== current.kind;
}
