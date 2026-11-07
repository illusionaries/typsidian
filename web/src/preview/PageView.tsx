/**
 * One rendered page of the preview stack.
 *
 * The server hands us a self-contained SVG per page (glyph defs inlined, ids
 * prefixed). We inject it verbatim: the SVG is the *typeset document*, so text
 * inside it stays selectable and searchable. Everything interactive is drawn in
 * separate overlay layers with `pointer-events: none`, which keeps browser text
 * selection free (no transparent hit areas on top of the page).
 *
 * Overlay coordinates are expressed as percentages of the page box, so they
 * stay glued to the glyphs at any zoom level.
 */

import { useCallback } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { Rect, RenderedPage } from '../../../shared/doc';

export interface PageViewProps {
  page: RenderedPage;
  /** 1-based number shown in the corner badge. */
  pageNumber: number;
  /** Displayed size, CSS pixels. */
  widthPx: number;
  heightPx: number;
  /** Rects of the block containing the caret (this page only). */
  activeRects: Rect[];
  /** Rect of the hovered block (this page only). */
  hoverRect: Rect | null;
  /** Label chip for the hovered block (visual mode only). */
  hoverLabel: string | null;
  /** Tooltip for the hover chip. */
  hoverHint: string;
  /** Rects of the block being edited; its rendered glyphs are masked out. */
  maskRects: Rect[];
  /** Inline block editor, when this page owns the block being edited. */
  editingOverlay: ReactNode;
  /** Registers the DOM node so the surface can map points to page rects. */
  registerPage(index: number, element: HTMLDivElement | null): void;
}

/** A page-local point rect as CSS percentages of the page box. */
function rectStyle(rect: Rect, page: RenderedPage): CSSProperties {
  const pageWidth = page.widthPt > 0 ? page.widthPt : Math.max(1, rect.x + rect.width);
  const pageHeight = page.heightPt > 0 ? page.heightPt : Math.max(1, rect.y + rect.height);
  return {
    left: `${(rect.x / pageWidth) * 100}%`,
    top: `${(rect.y / pageHeight) * 100}%`,
    width: `${Math.max(0.1, (rect.width / pageWidth) * 100)}%`,
    height: `${Math.max(0.1, (rect.height / pageHeight) * 100)}%`,
  };
}

export function PageView(props: PageViewProps) {
  const {
    page,
    pageNumber,
    widthPx,
    heightPx,
    activeRects,
    hoverRect,
    hoverLabel,
    maskRects,
    editingOverlay,
  } = props;
  const { registerPage } = props;

  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      registerPage(page.index, element);
    },
    [registerPage, page.index],
  );

  return (
    <div
      ref={setRef}
      className="ts-page"
      data-page-index={page.index}
      data-page-number={pageNumber}
      style={{ width: widthPx, height: heightPx }}
      aria-label={`Page ${pageNumber} of the typeset document`}
    >
      {/* The typeset page. Never wrapped in a hit-area: text selection must
          keep working, so interaction is handled by point mapping instead. */}
      <div className="ts-page__sheet" dangerouslySetInnerHTML={{ __html: page.svg }} />

      <div className="ts-page__annotations" aria-hidden="true">
        {activeRects.map((rect, index) => (
          <div
            key={`active-${index}`}
            className="ts-block-outline ts-block-outline--active"
            style={rectStyle(rect, page)}
          />
        ))}
        {hoverRect ? (
          <div
            className="ts-block-outline ts-block-outline--hover"
            style={rectStyle(hoverRect, page)}
          >
            {hoverLabel ? (
              <span className="ts-block-outline__chip" title={props.hoverHint}>
                {hoverLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {maskRects.length > 0 ? (
        <div className="ts-page__masks" aria-hidden="true">
          {maskRects.map((rect, index) => (
            <div
              key={`mask-${index}`}
              className="ts-page__mask"
              style={rectStyle(rect, page)}
            />
          ))}
        </div>
      ) : null}

      {editingOverlay}

      <span className="ts-page__badge" aria-hidden="true">
        {pageNumber}
      </span>
    </div>
  );
}
