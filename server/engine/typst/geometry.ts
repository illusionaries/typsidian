/**
 * Block geometry: turn marker positions into page-local rectangles.
 *
 * The instrumented compile reports, for every block boundary, the page it ended
 * up on plus the page-local position (in points) where the marker sits. Block
 * `i` spans from marker `i` to marker `i + 1`, so folding the marker list yields
 * a rectangle per block. All rectangles are page-local and are clamped into the
 * page so the preview can use them directly for hit testing.
 *
 * Two refinements over the naive fold:
 *  - the very first marker is emitted before the page setup rules are applied
 *    and therefore reports `(0, 0)`; per-page content insets are derived from
 *    the markers that do have a real position,
 *  - column layout is detected from the distinct marker x positions per page, so
 *    a block in the right column gets a box on the right side instead of one
 *    that spans the whole page.
 */

import type { BlockBox, DocBlock, Rect, RenderedPage } from '../../../shared/doc';

export interface MarkerPosition {
  /** Zero-based page index. */
  page: number;
  x: number;
  y: number;
}

/** Two marker x values this close together belong to the same column. */
const COLUMN_TOLERANCE = 3;
const MIN_WIDTH = 24;
const MIN_HEIGHT = 1;

interface PageInsets {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Round to 1/100 pt; keeps JSON payloads small and hit testing stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Per-page left/top content insets, derived from markers with a real position. */
function pageInsets(markers: MarkerPosition[], pages: RenderedPage[]): Map<number, PageInsets> {
  const map = new Map<number, PageInsets & { count: number }>();
  let globalLeft = Number.POSITIVE_INFINITY;
  let globalTop = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    // Markers emitted before any page setup report (0, 0); ignore them.
    if (marker.x < 1 && marker.y < 1) continue;
    if (marker.page < 0 || marker.page >= pages.length) continue;
    globalLeft = Math.min(globalLeft, marker.x);
    globalTop = Math.min(globalTop, marker.y);
    const current = map.get(marker.page);
    map.set(marker.page, {
      left: current ? Math.min(current.left, marker.x) : marker.x,
      top: current ? Math.min(current.top, marker.y) : marker.y,
      count: (current?.count ?? 0) + 1,
    });
  }
  if (map.size === 0) {
    map.set(0, { left: 0, top: 0, count: 0 });
    return map;
  }
  if (!Number.isFinite(globalLeft) || !Number.isFinite(globalTop)) {
    globalLeft = 0;
    globalTop = 0;
  }
  const result = new Map<number, PageInsets>();
  for (const [page, inset] of map) {
    if (inset.count <= 1) {
      // A page with just one marker carries only the end marker of a block
      // that started on a previous page. That marker sits *after* the page's
      // content, so derive the content inset from the rest of the document
      // instead of from the marker itself.
      result.set(page, {
        left: Math.min(inset.left, globalLeft),
        top: Math.min(inset.top, globalTop),
      });
    } else {
      result.set(page, { left: inset.left, top: inset.top });
    }
  }
  return result;
}

/** Distinct column left edges on one page, clustered and sorted. */
function columnsOnPage(markers: MarkerPosition[], page: number): number[] {
  const xs = markers
    .filter((marker) => marker.page === page)
    .map((marker) => marker.x)
    .sort((a, b) => a - b);
  const columns: number[] = [];
  for (const x of xs) {
    const last = columns[columns.length - 1];
    if (last === undefined || x - last > COLUMN_TOLERANCE) columns.push(x);
  }
  return columns;
}

/** Fold marker positions into page-local rectangles per block. */
export function buildGeometry(
  blocks: DocBlock[],
  markers: MarkerPosition[],
  pages: RenderedPage[],
): BlockBox[] {
  if (pages.length === 0) return [];
  if (markers.length !== blocks.length + 1) return [];

  const insets = pageInsets(markers, pages);
  const normalized: MarkerPosition[] = markers.map((marker) => {
    const page = clamp(Math.floor(marker.page), 0, pages.length - 1);
    const inset = insets.get(page) ?? { left: 0, top: 0 };
    return {
      page,
      x: Math.max(marker.x, inset.left),
      y: Math.max(marker.y, inset.top),
    };
  });

  const columns = new Map<number, number[]>();
  const columnFor = (page: number): number[] => {
    const known = columns.get(page);
    if (known) return known;
    const computed = columnsOnPage(normalized, page);
    columns.set(page, computed);
    return computed;
  };

  /** Right edge available to a block starting at column `x` on `page`. */
  const columnRight = (page: number, x: number): number => {
    const pageInfo = pages[page];
    const inset = insets.get(page) ?? { left: 0, top: 0 };
    const rightEdge = Math.max(inset.left, pageInfo.widthPt - inset.left);
    const cols = columnFor(page);
    for (const column of cols) {
      if (column > x + COLUMN_TOLERANCE) return Math.min(rightEdge, column - 2);
    }
    return rightEdge;
  };

  const contentBottom = (page: number): number => {
    const pageInfo = pages[page];
    const inset = insets.get(page) ?? { left: 0, top: 0 };
    // Assume a symmetric page margin; this matches every Typst page setup that
    // only changes `margin` (the common case) and stays inside the page.
    return Math.max(inset.top, pageInfo.heightPt - inset.top);
  };

  const boxes: BlockBox[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const start = normalized[index];
    const end = normalized[index + 1];
    const pageStart = start.page;
    const pageEnd = Math.max(pageStart, Math.min(end.page, pages.length - 1));
    const rects: Array<Rect & { page: number }> = [];

    if (pageStart === pageEnd) {
      const pageInfo = pages[pageStart];
      const inset = insets.get(pageStart) ?? { left: 0, top: 0 };
      const insetLeft = Math.max(0, inset.left);
      const crossColumn = Math.abs(end.x - start.x) > COLUMN_TOLERANCE;
      const x = clamp(crossColumn ? insetLeft : start.x, 0, pageInfo.widthPt);
      const maxRight = clamp(pageInfo.widthPt - insetLeft, x + MIN_WIDTH, pageInfo.widthPt);
      const right = crossColumn ? maxRight : clamp(columnRight(pageStart, x), x + MIN_WIDTH, maxRight);
      const y = clamp(start.y, 0, Math.max(0, pageInfo.heightPt - MIN_HEIGHT));
      const height = clamp(end.y - start.y, MIN_HEIGHT, pageInfo.heightPt - y);
      rects.push({ page: pageStart, x: round(x), y: round(y), width: round(right - x), height: round(height) });
    } else {
      const first = pages[pageStart];
      const firstInset = insets.get(pageStart) ?? { left: 0, top: 0 };
      const firstX = clamp(start.x, 0, first.widthPt);
      const firstRight = clamp(
        columnRight(pageStart, firstX),
        firstX + MIN_WIDTH,
        Math.max(firstInset.left, first.widthPt - firstInset.left),
      );
      const firstY = clamp(start.y, 0, Math.max(0, first.heightPt - MIN_HEIGHT));
      rects.push({
        page: pageStart,
        x: round(firstX),
        y: round(firstY),
        width: round(firstRight - firstX),
        height: round(clamp(contentBottom(pageStart) - firstY, MIN_HEIGHT, first.heightPt - firstY)),
      });
      for (let page = pageStart + 1; page < pageEnd; page++) {
        const info = pages[page];
        const inset = insets.get(page) ?? { left: 0, top: 0 };
        rects.push({
          page,
          x: round(inset.left),
          y: round(inset.top),
          width: round(Math.max(MIN_WIDTH, info.widthPt - inset.left * 2)),
          height: round(Math.max(MIN_HEIGHT, info.heightPt - inset.top * 2)),
        });
      }
      const last = pages[pageEnd];
      const lastInset = insets.get(pageEnd) ?? { left: 0, top: 0 };
      const lastY = clamp(lastInset.top, 0, Math.max(0, last.heightPt - MIN_HEIGHT));
      const lastRight = Math.max(
        lastInset.left + MIN_WIDTH,
        last.widthPt - lastInset.left,
      );
      rects.push({
        page: pageEnd,
        x: round(lastInset.left),
        y: round(lastY),
        width: round(clamp(lastRight - lastInset.left, MIN_WIDTH, last.widthPt - lastInset.left)),
        height: round(clamp(end.y - lastY, MIN_HEIGHT, last.heightPt - lastY)),
      });
    }
    boxes.push({ blockId: blocks[index].id, rects });
  }
  return boxes;
}
