/**
 * PreviewSurface — the rendered document for all three view modes.
 *
 *  - `split` / `preview`: a read-only page stack. Clicking a page maps the
 *    point to a block (universal `blockAtPoint`) and jumps the source caret to
 *    it.
 *  - `visual`: the same page stack, plus hover outlines + label chips and an
 *    inline block editor that opens over the clicked block. The editor is a
 *    real CodeMirror instance fed by the language client's `editableText`,
 *    `actions` and `editorExtensions`.
 *
 * The component is language agnostic: it only sees pages, boxes, blocks and
 * splices.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

import { blockAtPoint } from '../../../shared/doc';
import type { DocBlock, Rect, RenderedPage } from '../../../shared/doc';
import type { PreviewSurfaceProps } from '../contracts';
import { InlineBlockEditor } from '../visual/InlineBlockEditor';
import { PageView } from './PageView';
import './preview.css';

/** Horizontal air between the page edges and the pane. */
const VIEWPORT_PADDING = 28;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
/** How long a scroll-to-block wins over scroll-sync feedback, in ms. */
const REVEAL_SUPPRESS_MS = 700;

const NO_PAGES: RenderedPage[] = [];
const NO_RECTS: Array<Rect & { page: number }> = [];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Human label for the inline editor toolbar. */
function kindLabel(block: DocBlock): string {
  switch (block.kind) {
    case 'heading':
      return block.level ? `Heading ${block.level}` : 'Heading';
    case 'paragraph':
      return 'Paragraph';
    case 'list':
      return 'List';
    case 'quote':
      return 'Quote';
    case 'code':
      return 'Code';
    case 'math':
      return 'Equation';
    case 'table':
      return 'Table';
    case 'figure':
      return 'Figure';
    case 'raw':
      return 'Raw';
    case 'rule':
      return 'Rule';
    default:
      return 'Block';
  }
}

export function PreviewSurface(props: PreviewSurfaceProps) {
  const {
    render,
    source,
    language,
    mode,
    zoom,
    pending,
    error,
    activeBlockId,
    revealBlockId,
    editingBlockId,
    onRequestEdit,
    onActivateBlock,
    onRunBlockAction,
    onEditBlockText,
    onCommitEdit,
    onZoom,
    onVisibleBlock,
  } = props;

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pageElements = useRef(new Map<number, HTMLDivElement>());
  const lastVisibleBlockRef = useRef<string | null>(null);
  const lastPageRef = useRef(0);
  const suppressUntilRef = useRef(0);
  const suppressTimerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const emitRef = useRef<() => void>(() => undefined);
  const revealAppliedRef = useRef<{ id: string | null; done: boolean }>({ id: null, done: true });

  const [viewportWidth, setViewportWidth] = useState(0);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [visiblePageIndex, setVisiblePageIndex] = useState(0);

  const pages = render?.pages ?? NO_PAGES;
  const blocksById = useMemo(() => {
    const map = new Map<string, DocBlock>();
    if (render) for (const block of render.blocks) map.set(block.id, block);
    return map;
  }, [render]);
  const boxesById = useMemo(() => {
    const map = new Map<string, Array<Rect & { page: number }>>();
    if (render) for (const box of render.boxes) map.set(box.blockId, box.rects);
    return map;
  }, [render]);

  // ------------------------------------------------------------- fit scale --

  const maxPageWidthPt = useMemo(() => {
    let maximum = 0;
    for (const page of pages) if (page.widthPt > maximum) maximum = page.widthPt;
    return maximum;
  }, [pages]);

  // Zoom 1 means "fit the pane width": the paper stack is always exactly as
  // wide as the pane, so there is no horizontal scrolling at the default zoom.
  const fitPxPerPt = useMemo(() => {
    if (viewportWidth <= 0 || maxPageWidthPt <= 0) return 1;
    const available = Math.max(120, viewportWidth - VIEWPORT_PADDING * 2);
    return Math.max(0.1, available / maxPageWidthPt);
  }, [viewportWidth, maxPageWidthPt]);
  const pxPerPt = fitPxPerPt * zoom;
  const zoomPercent = Math.round(zoom * 100);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setViewportWidth(scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // ----------------------------------------------------------- scroll sync ---

  /** Topmost block whose rendered box is visible, plus the current page. */
  const emitScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();

    let pageIndex = 0;
    for (let index = 0; index < (render?.pages.length ?? 0); index++) {
      const element = pageElements.current.get(index);
      if (!element) continue;
      if (element.getBoundingClientRect().top <= viewport.top + 72) pageIndex = index;
    }
    if (pageIndex !== lastPageRef.current) {
      lastPageRef.current = pageIndex;
      setVisiblePageIndex(pageIndex);
    }

    if (!render) {
      if (lastVisibleBlockRef.current !== null) {
        lastVisibleBlockRef.current = null;
        onVisibleBlock(null);
      }
      return;
    }
    if (performance.now() < suppressUntilRef.current) return;

    let bestId: string | null = null;
    let bestTop = Number.POSITIVE_INFINITY;
    for (const block of render.blocks) {
      const rects = boxesById.get(block.id);
      if (!rects || rects.length === 0) continue;
      for (const rect of rects) {
        const page = render.pages[rect.page];
        const element = pageElements.current.get(rect.page);
        if (!page || !element || page.heightPt <= 0) continue;
        const pageRect = element.getBoundingClientRect();
        const scale = pageRect.height / page.heightPt;
        const top = pageRect.top + rect.y * scale;
        const bottom = top + rect.height * scale;
        if (bottom > viewport.top + 6 && top < bestTop) {
          bestTop = top;
          bestId = block.id;
        }
      }
    }

    if (bestId !== lastVisibleBlockRef.current) {
      lastVisibleBlockRef.current = bestId;
      onVisibleBlock(bestId);
    }
  }, [render, boxesById, onVisibleBlock]);
  emitRef.current = emitScrollState;

  const scheduleScrollEmit = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      emitScrollState();
    });
  }, [emitScrollState]);

  // Recompute the visible block after every render / zoom / resize.
  useEffect(() => {
    const frame = requestAnimationFrame(() => emitScrollState());
    return () => cancelAnimationFrame(frame);
  }, [emitScrollState, pxPerPt, viewportWidth]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    },
    [],
  );

  const registerPage = useCallback((index: number, element: HTMLDivElement | null) => {
    if (element) pageElements.current.set(index, element);
    else pageElements.current.delete(index);
  }, []);

  // --------------------------------------------------------------- reveal ----

  useEffect(() => {
    if (!revealBlockId) {
      revealAppliedRef.current = { id: null, done: true };
      return;
    }
    const applied = revealAppliedRef.current;
    if (applied.id !== revealBlockId) {
      revealAppliedRef.current = { id: revealBlockId, done: false };
    }
    if (revealAppliedRef.current.done || !render) return;

    const box = render.boxes.find((candidate) => candidate.blockId === revealBlockId);
    const scroller = scrollerRef.current;
    const rect = box?.rects[0];
    if (!rect || !scroller) {
      if (box && box.rects.length === 0) revealAppliedRef.current.done = true;
      return;
    }
    const page = render.pages[rect.page];
    const element = pageElements.current.get(rect.page);
    if (!page || !element || page.heightPt <= 0) return;
    revealAppliedRef.current.done = true;

    const pageRect = element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const scale = pageRect.height / page.heightPt;
    const topInScroller =
      scroller.scrollTop + (pageRect.top - scrollerRect.top) + rect.y * scale;
    const bottomInScroller = topInScroller + rect.height * scale;
    const alreadyVisible =
      topInScroller >= scroller.scrollTop + 20 &&
      bottomInScroller <= scroller.scrollTop + scroller.clientHeight - 20;
    if (alreadyVisible) return;

    suppressUntilRef.current = performance.now() + REVEAL_SUPPRESS_MS;
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      suppressTimerRef.current = null;
      suppressUntilRef.current = 0;
      emitRef.current();
    }, REVEAL_SUPPRESS_MS + 80);

    const target = Math.max(0, topInScroller - Math.min(110, scroller.clientHeight * 0.2));
    scroller.scrollTo({ top: target, behavior: 'smooth' });
  }, [revealBlockId, render]);

  // ------------------------------------------------------------- hovering ----

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!render) return;
      const target = event.target as Element | null;
      if (target?.closest('.ts-inline-editor')) {
        setHoveredBlockId((current) => (current === null ? current : null));
        return;
      }
      const pageElement = target?.closest('[data-page-index]') as HTMLElement | null;
      if (!pageElement) {
        setHoveredBlockId((current) => (current === null ? current : null));
        return;
      }
      const pageIndex = Number(pageElement.dataset.pageIndex);
      const page = Number.isFinite(pageIndex) ? render.pages[pageIndex] : undefined;
      if (!page) return;
      const bounds = pageElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = ((event.clientX - bounds.left) / bounds.width) * page.widthPt;
      const y = ((event.clientY - bounds.top) / bounds.height) * page.heightPt;
      const block = blockAtPoint(render, pageIndex, x, y);
      const nextId = block ? block.id : null;
      setHoveredBlockId((current) => (current === nextId ? current : nextId));
    },
    [render],
  );

  const handlePointerLeave = useCallback(() => {
    setHoveredBlockId((current) => (current === null ? current : null));
  }, []);

  // -------------------------------------------------------------- clicking ---

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!render || event.defaultPrevented || event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest('.ts-inline-editor')) return;

      const finishVisual = () => {
        if (mode === 'visual' && editingBlockId) onRequestEdit(null);
      };

      const pageElement = target?.closest('[data-page-index]') as HTMLElement | null;
      if (!pageElement) {
        finishVisual();
        return;
      }
      // A non-empty selection means the user was selecting text, not clicking
      // through: leave copy / select alone.
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && selection.toString().length > 0) return;

      const pageIndex = Number(pageElement.dataset.pageIndex);
      const page = Number.isFinite(pageIndex) ? render.pages[pageIndex] : undefined;
      if (!page) return;
      const bounds = pageElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = ((event.clientX - bounds.left) / bounds.width) * page.widthPt;
      const y = ((event.clientY - bounds.top) / bounds.height) * page.heightPt;
      const block = blockAtPoint(render, pageIndex, x, y);
      if (!block) {
        finishVisual();
        return;
      }
      if (mode === 'visual') onRequestEdit(block.id);
      else onActivateBlock(block);
    },
    [render, mode, editingBlockId, onRequestEdit, onActivateBlock],
  );

  // ------------------------------------------------------------------ zoom ---

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clamp(Math.round(next * 100) / 100, ZOOM_MIN, ZOOM_MAX);
      if (clamped !== zoom) onZoom(clamped);
    },
    [onZoom, zoom],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        applyZoom(zoom + ZOOM_STEP);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        applyZoom(zoom - ZOOM_STEP);
      } else if (event.key === '0') {
        event.preventDefault();
        onZoom(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [applyZoom, onZoom, zoom]);

  // ------------------------------------------------------------- rendering ---

  const hoveredBlock = hoveredBlockId ? blocksById.get(hoveredBlockId) ?? null : null;
  const hoveredRects = hoveredBlockId ? boxesById.get(hoveredBlockId) ?? NO_RECTS : NO_RECTS;
  const hoveredIsHidden = hoveredBlockId !== null && hoveredBlockId === editingBlockId;

  const editingBlock = editingBlockId ? blocksById.get(editingBlockId) ?? null : null;
  const editingRects = editingBlockId ? boxesById.get(editingBlockId) ?? NO_RECTS : NO_RECTS;
  const editingRect = editingRects.length > 0 ? editingRects[0] : null;
  const editingPage =
    render && editingRect ? render.pages[editingRect.page] ?? null : null;
  const editingPageIndex = editingPage && editingRect ? editingRect.page : -1;

  const editingOverlay =
    editingBlock && editingRect && editingPage ? (
      <InlineBlockEditor
        key={editingBlock.id}
        block={editingBlock}
        rect={editingRect}
        page={editingPage}
        pxPerPt={pxPerPt}
        source={source}
        language={language}
        pending={pending}
        renderRevision={render?.stats.revision ?? 0}
        onEditBlockText={onEditBlockText}
        onCommitEdit={onCommitEdit}
        onRunBlockAction={onRunBlockAction}
      />
    ) : null;

  // The caret-driven highlight is meaningful in split / visual mode; a pure
  // read-only preview stays clean.
  const activeRects =
    mode !== 'preview' && activeBlockId && activeBlockId !== editingBlockId
      ? boxesById.get(activeBlockId) ?? NO_RECTS
      : NO_RECTS;
  const pageCount = pages.length;
  const pagerPage = Math.min(visiblePageIndex + 1, Math.max(1, pageCount));

  return (
    <div
      className={`ts-preview ts-preview--${mode}${pending ? ' is-pending' : ''}`}
      role="region"
      aria-label="Rendered document"
      data-reveal-id={revealBlockId ?? ''}
    >
      {pending ? <div className="ts-preview__progress" aria-hidden="true" /> : null}

      {error ? (
        <div className="ts-preview__error" role="alert">
          <span className="ts-preview__error-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="ts-preview__error-text">{error}</span>
        </div>
      ) : null}

      <div
        ref={scrollerRef}
        className="ts-preview__scroller"
        onScroll={scheduleScrollEmit}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        {pageCount > 0 ? (
          <div className="ts-preview__stack">
            {pages.map((page, index) => {
              const hoverRect = hoveredRects.find((rect) => rect.page === page.index) ?? null;
              const showChip =
                mode === 'visual' &&
                hoveredBlock !== null &&
                !hoveredIsHidden &&
                hoverRect !== null &&
                (hoveredRects[0]?.page ?? -1) === page.index;
              return (
                <PageView
                  key={page.index}
                  page={page}
                  pageNumber={index + 1}
                  widthPx={Math.max(1, Math.round(page.widthPt * pxPerPt))}
                  heightPx={Math.max(1, Math.round(page.heightPt * pxPerPt))}
                  activeRects={activeRects.filter((rect) => rect.page === page.index)}
                  hoverRect={hoveredIsHidden ? null : hoverRect}
                  hoverLabel={
                    showChip && hoveredBlock
                      ? `✎ ${hoveredBlock.label || kindLabel(hoveredBlock)}`
                      : null
                  }
                  hoverHint="Click to edit this block in place"
                  editingOverlay={index === editingPageIndex ? editingOverlay : null}
                  registerPage={registerPage}
                />
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state__title">{pending ? 'Rendering…' : 'Nothing to preview'}</div>
            <div className="empty-state__hint">
              {pending
                ? 'Typst is typesetting the document.'
                : 'Open a Typst file, or start typing in the source pane, to see the typeset page here.'}
            </div>
            {pending ? <div className="spinner" /> : null}
          </div>
        )}
      </div>

      {mode === 'visual' ? (
        <div className="ts-preview__hint" aria-hidden="true">
          {editingBlockId ? (
            <>
              Editing block · press <kbd>Esc</kbd> when done
            </>
          ) : (
            <>Click any block to edit it in place</>
          )}
        </div>
      ) : null}

      <div className="ts-preview__hud" role="group" aria-label="Pages and zoom">
        {pageCount > 1 ? (
          <span className="ts-preview__pager" aria-label={`Page ${pagerPage} of ${pageCount}`}>
            {pagerPage} / {pageCount}
          </span>
        ) : null}
        {pageCount > 1 ? <span className="ts-preview__hud-divider" aria-hidden="true" /> : null}
        <button
          type="button"
          className="ts-preview__zoom-button"
          onClick={() => applyZoom(zoom - ZOOM_STEP)}
          title="Zoom out (⌘−)"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="ts-preview__zoom-value"
          onClick={() => onZoom(1)}
          title="Fit to pane width (⌘0)"
          aria-label={`Zoom ${zoomPercent} percent. Reset to fit.`}
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          className="ts-preview__zoom-button"
          onClick={() => applyZoom(zoom + ZOOM_STEP)}
          title="Zoom in (⌘+)"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>
  );
}

export default PreviewSurface;
