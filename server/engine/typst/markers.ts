/**
 * Geometry instrumentation.
 *
 * Every block is preceded by one invisible marker line:
 *
 *     #context[#metadata((typsidian_block: N, x: here().position().x,
 *                           y: here().position().y, page: here().page()))]
 *
 * `here().position()` is resolved by Typst's introspection, and `metadata` has
 * no layout footprint, so the marker line contributes nothing to the frame.
 * The layout neutrality of this scheme is asserted by `scripts/test-engine.mts`
 * (clean vs. instrumented SVG output must be identical).
 *
 * A final marker with index `blocks.length` is appended after the document so
 * the last block has an end position too.
 */

import type { DocBlock } from '../../../shared/doc';

export const MARKER_KEY = 'typsidian_block';

/** Build the marker line inserted in front of block `index`. */
export function markerLine(index: number): string {
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
 * Insert a marker line in front of every block.
 *
 * Markers are always placed at a line start, which keeps the markup valid even
 * for blocks that begin in the middle of a line. Two blocks that share a line
 * start get their markers stacked (this happens only for zero-height constructs
 * such as two adjacent statements).
 *
 * Blocks are expected to be ordered and non-overlapping (true for both the
 * native parser and the heuristic fallback).
 */
export function instrument(source: string, blocks: DocBlock[]): string {
  const insertions = new Map<number, number[]>();
  for (let index = 0; index < blocks.length; index++) {
    let lineStart = source.lastIndexOf('\n', blocks[index].range.from - 1) + 1;
    // A Typst shebang is only a shebang on the very first line; putting a
    // marker in front of it would turn the rest of the script into an error.
    // Keep it first and instrument the block after it.
    if (lineStart === 0 && source.startsWith('#!')) {
      const lineEnd = source.indexOf('\n');
      lineStart = lineEnd < 0 ? source.length : lineEnd + 1;
    }
    const list = insertions.get(lineStart);
    if (list) list.push(index);
    else insertions.set(lineStart, [index]);
  }
  const points = [...insertions.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let cursor = 0;
  for (const point of points) {
    parts.push(source.slice(cursor, point));
    for (const blockIndex of insertions.get(point)!) {
      parts.push(markerLine(blockIndex), '\n');
    }
    cursor = point;
  }
  parts.push(source.slice(cursor));
  // End-of-document marker: lets the last block know where it stops.
  parts.push('\n', markerLine(blocks.length), '\n');
  return parts.join('');
}
