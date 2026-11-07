/**
 * Inline block editor — the heart of visual mode.
 *
 * A floating card anchored over the current render's rectangle for one block.
 * It hosts a real CodeMirror instance whose document is the language client's
 * `editableText` for that block. Every keystroke is reported through
 * `onEditBlockText`; the shell debounces the server render, so the card must
 * survive re-renders (React keeps the component instance as long as the editing
 * block id, and therefore this component's `key`, does not change) and track
 * the *new* rectangle on every render.
 *
 * The card is language agnostic: highlighting, block actions and the editable
 * text all come from `getLanguageClient(language)`.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';

import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

import { blockText } from '../../../shared/doc';
import type { DocBlock, Rect, RenderedPage } from '../../../shared/doc';
import { getLanguageClient } from '../languages';
import './visual.css';

export interface InlineBlockEditorProps {
  block: DocBlock;
  /** Rendered rectangle of the block (page-local points, on `page`). */
  rect: Rect & { page: number };
  page: RenderedPage;
  /** CSS pixels per page point at the current zoom. */
  pxPerPt: number;
  /** Current source; used to resync the editor after a toolbar action. */
  source: string;
  language: string;
  /** A render is in flight; never resync the document from stale blocks. */
  pending: boolean;
  /** Render revision, so external (action) splices can be detected. */
  renderRevision: number;
  onEditBlockText(blockId: string, text: string): void;
  onCommitEdit(): void;
  onRunBlockAction(blockId: string, actionId: string): void;
}

/** Human label for the card header. */
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

const CARD_MIN_WIDTH = 420;
const CARD_MAX_WIDTH = 720;

/** Editor chrome; colours are the shell's variables so themes just work. */
const inlineEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'transparent',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    maxHeight: 'min(48vh, 430px)',
    overflowY: 'auto',
  },
  '.cm-content': {
    padding: '10px 12px',
    caretColor: 'var(--accent)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-content ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-placeholder': {
    color: 'var(--fg-subtle)',
  },
});

/** Typst-ish syntax colours, all expressed through CSS variables. */
const inlineHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--syntax-heading, var(--accent))', fontWeight: '600' },
  { tag: tags.strong, color: 'var(--fg)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--fg)', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'var(--fg-muted)', textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--syntax-link, var(--accent))', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--syntax-string, var(--success))' },
  { tag: tags.string, color: 'var(--syntax-string, var(--success))' },
  { tag: tags.keyword, color: 'var(--syntax-keyword, var(--accent))' },
  { tag: tags.comment, color: 'var(--fg-subtle)', fontStyle: 'italic' },
  { tag: [tags.number, tags.atom, tags.bool], color: 'var(--syntax-number, var(--warning))' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--fg-muted)' },
  { tag: tags.processingInstruction, color: 'var(--syntax-meta, var(--fg-subtle))' },
  {
    tag: [tags.typeName, tags.function(tags.variableName), tags.labelName],
    color: 'var(--syntax-function, var(--accent))',
  },
  { tag: tags.meta, color: 'var(--fg-subtle)' },
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function InlineBlockEditor(props: InlineBlockEditorProps) {
  const { block, rect, page, pxPerPt, source, language, pending, renderRevision } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountedRef = useRef(false);
  const lastEmittedRef = useRef<string | null>(null);
  const suppressEmitRef = useRef(false);
  const pendingActionRevisionRef = useRef<number | null>(null);
  const actionTimerRef = useRef<number | null>(null);

  // Always-current callbacks: the CodeMirror instance is created once.
  const callbacksRef = useRef({
    onEditBlockText: props.onEditBlockText,
    onCommitEdit: props.onCommitEdit,
  });
  useEffect(() => {
    callbacksRef.current = {
      onEditBlockText: props.onEditBlockText,
      onCommitEdit: props.onCommitEdit,
    };
  }, [props.onEditBlockText, props.onCommitEdit]);

  const blockIdRef = useRef(block.id);
  blockIdRef.current = block.id;

  // The initial document is computed once: the component is keyed by block id,
  // so a new block always remounts it.
  const initialTextRef = useRef<string | null>(null);
  if (initialTextRef.current === null) {
    try {
      initialTextRef.current = getLanguageClient(language).editableText(source, block);
    } catch {
      initialTextRef.current = blockText(source, block);
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    mountedRef.current = true;

    let languageExtensions: Extension[] = [];
    try {
      languageExtensions = getLanguageClient(language).editorExtensions() as Extension[];
    } catch {
      languageExtensions = [];
    }

    const commit = () => {
      callbacksRef.current.onCommitEdit();
    };

    const state = EditorState.create({
      doc: initialTextRef.current ?? '',
      extensions: [
        ...languageExtensions,
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        keymap.of([
          {
            key: 'Escape',
            run: () => {
              commit();
              return true;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              commit();
              return true;
            },
          },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          lastEmittedRef.current = text;
          if (suppressEmitRef.current) {
            suppressEmitRef.current = false;
            return;
          }
          callbacksRef.current.onEditBlockText(blockIdRef.current, text);
        }),
        inlineEditorTheme,
        syntaxHighlighting(inlineHighlight, { fallback: true }),
        EditorView.domEventHandlers({
          blur: () => {
            // Let a click on another surface block sort itself out first, then
            // commit only if focus really left the card.
            window.setTimeout(() => {
              if (!mountedRef.current) return;
              const active = document.activeElement;
              const root = rootRef.current;
              if (active && root && (root === active || root.contains(active))) return;
              commit();
            }, 0);
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    const frame = requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      view.focus();
      rootRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(frame);
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only: the component's key is the block id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current);
    },
    [],
  );

  const client = getLanguageClient(language);
  const actions = useMemo(() => {
    try {
      return client.actions(source, block);
    } catch {
      return [];
    }
  }, [client, source, block]);

  /**
   * Toolbar actions splice the *source*; the shell re-renders and the block
   * prop is replaced. Once that render lands (revision changed, not pending) we
   * fold the new editable text back into the CodeMirror document. We never
   * resync while typing, because mid-flight renders still describe the previous
   * block ranges.
   */
  const runAction = useCallback(
    (actionId: string) => {
      pendingActionRevisionRef.current = renderRevision;
      if (actionTimerRef.current !== null) window.clearTimeout(actionTimerRef.current);
      actionTimerRef.current = window.setTimeout(() => {
        pendingActionRevisionRef.current = null;
        actionTimerRef.current = null;
      }, 2500);
      props.onRunBlockAction(block.id, actionId);
    },
    [block.id, props.onRunBlockAction, renderRevision],
  );

  useEffect(() => {
    const fromRevision = pendingActionRevisionRef.current;
    if (fromRevision === null || pending || renderRevision === fromRevision) return;
    pendingActionRevisionRef.current = null;
    if (actionTimerRef.current !== null) {
      window.clearTimeout(actionTimerRef.current);
      actionTimerRef.current = null;
    }
    const view = viewRef.current;
    if (!view) return;
    let desired: string;
    try {
      desired = getLanguageClient(language).editableText(source, block);
    } catch {
      return;
    }
    const current = view.state.doc.toString();
    if (desired === current) {
      lastEmittedRef.current = desired;
      return;
    }
    const selection = view.state.selection.main;
    suppressEmitRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: desired },
      selection: {
        anchor: Math.min(selection.anchor, desired.length),
        head: Math.min(selection.head, desired.length),
      },
    });
    lastEmittedRef.current = desired;
  }, [pending, renderRevision, source, block, language]);

  const pageWidthPx = page.widthPt * pxPerPt;
  const cardWidth = clamp(rect.width * pxPerPt, CARD_MIN_WIDTH, CARD_MAX_WIDTH);
  const left = Math.max(
    0,
    Math.min(rect.x * pxPerPt, Math.max(0, pageWidthPx - cardWidth - 10)),
  );
  const top = Math.max(0, rect.y * pxPerPt - 6);
  const style: CSSProperties = { left, top, width: cardWidth };

  return (
    <div
      ref={rootRef}
      className="ts-inline-editor"
      style={style}
      data-block-id={block.id}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="ts-inline-editor__toolbar"
        onMouseDown={(event) => event.preventDefault()}
      >
        <span className="ts-inline-editor__kind">{kindLabel(block)}</span>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="ts-inline-editor__action"
            title={action.hint ? `${action.label} (${action.hint})` : action.label}
            onClick={() => runAction(action.id)}
          >
            {action.label}
          </button>
        ))}
        <span className="ts-inline-editor__spacer" />
        <span className="ts-inline-editor__esc">Esc to close</span>
        <button
          type="button"
          className="ts-inline-editor__close"
          title="Close editor (Esc)"
          aria-label="Close block editor"
          onClick={() => props.onCommitEdit()}
        >
          ×
        </button>
      </div>
      <div ref={hostRef} className="ts-inline-editor__host" />
    </div>
  );
}

export default InlineBlockEditor;
