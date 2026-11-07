/**
 * Split-mode source editor.
 *
 * A thin CodeMirror 6 wrapper around the universal {@link EditorPaneProps}
 * contract. It knows about blocks, ranges, diagnostics and splices — never
 * about Typst. Everything language specific comes from
 * `getLanguageClient(language)`.
 *
 * Props beyond the shared contract
 * --------------------------------
 * `blocks?: DocBlock[]` — the current render's block list, used to answer
 * "which block is the caret in?" (`onActiveBlock`). Optional and additive; the
 * shell passes it, other hosts can omit it.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';

import { blockAtOffset, minimalSplice } from '../../../shared/doc';
import type { BlockAction, DocBlock, SourceRange } from '../../../shared/doc';
import type { EditorPaneProps } from '../contracts';
import { getLanguageClient } from '../languages';
import { diagnosticsExtensions, setDiagnosticsEffect } from './diagnostics';
import { editorTheme, isDarkTheme } from './theme';

/** {@link EditorPaneProps} plus render data the editor can use locally. */
export interface EditorPaneExtendedProps extends EditorPaneProps {
  /** Blocks of the current render (`[]` while the first render is pending). */
  blocks?: DocBlock[];
}

interface ContextMenuState {
  x: number;
  y: number;
  block: DocBlock;
  actions: BlockAction[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The source editor surface. Controlled: the parent owns the text, this
 * component only reports edits through `onChange`.
 */
export function EditorPane(props: EditorPaneExtendedProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const extensionsRef = useRef<Extension[]>([]);
  const languageCompartmentRef = useRef<Compartment>(new Compartment());
  const themeCompartmentRef = useRef<Compartment>(new Compartment());

  // Always up-to-date props for CodeMirror callbacks, which outlive renders.
  const propsRef = useRef<EditorPaneExtendedProps>(props);
  propsRef.current = props;

  const applyingExternalRef = useRef(false);
  const visibleFrameRef = useRef<number | null>(null);
  const lastVisibleRef = useRef<SourceRange | null>(null);
  const lastCursorRef = useRef<{ offset: number; from: number; to: number } | null>(null);
  const lastActiveBlockIdRef = useRef<string | null>(null);
  const pathRef = useRef<string>(props.path);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuOpen = menu != null;

  // ------------------------------------------------------------- callbacks --

  function notifyCursor(state: EditorState): void {
    const main = state.selection.main;
    const current = propsRef.current;
    const cursor = { offset: main.head, from: main.from, to: main.to };
    const previous = lastCursorRef.current;
    // Dedupe: callbacks can be re-invoked for unrelated renders (e.g. a new
    // `blocks` array); only report real caret/selection movement.
    if (
      !previous ||
      previous.offset !== cursor.offset ||
      previous.from !== cursor.from ||
      previous.to !== cursor.to
    ) {
      lastCursorRef.current = cursor;
      current.onCursor(cursor);
    }

    const blocks = current.blocks;
    const block = blocks && blocks.length > 0 ? blockAtOffset(blocks, main.head) : null;
    const nextId = block?.id ?? null;
    if (nextId !== lastActiveBlockIdRef.current) {
      lastActiveBlockIdRef.current = nextId;
      current.onActiveBlock(block);
    }
  }

  function notifyVisible(): void {
    const view = viewRef.current;
    if (!view) return;
    const ranges = view.visibleRanges;
    if (ranges.length === 0) return;
    const doc = view.state.doc;
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    const range: SourceRange = {
      from: doc.lineAt(first.from).from,
      to: doc.lineAt(last.to).to,
    };
    const previous = lastVisibleRef.current;
    if (previous && previous.from === range.from && previous.to === range.to) return;
    lastVisibleRef.current = range;
    propsRef.current.onVisibleRange(range);
  }

  function scheduleVisible(): void {
    if (visibleFrameRef.current != null) return;
    visibleFrameRef.current = window.requestAnimationFrame(() => {
      visibleFrameRef.current = null;
      notifyVisible();
    });
  }

  function replaceDocument(source: string): void {
    const view = viewRef.current;
    if (!view) return;
    const extensions = extensionsRef.current;
    if (extensions.length === 0) return;
    view.setState(EditorState.create({ doc: source, extensions }));
    // Compartments and state fields are reset by `setState`; restore them.
    view.dispatch({
      effects: [
        languageCompartmentRef.current.reconfigure(
          getLanguageClient(propsRef.current.language).editorExtensions() as Extension[],
        ),
        themeCompartmentRef.current.reconfigure(editorTheme(isDarkTheme())),
        setDiagnosticsEffect.of(propsRef.current.diagnostics),
      ],
    });
    view.scrollDOM.scrollTop = 0;
    lastVisibleRef.current = null;
    lastCursorRef.current = null;
    lastActiveBlockIdRef.current = null;
    notifyCursor(view.state);
    scheduleVisible();
  }

  // ---------------------------------------------------------- view creation --

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const language = getLanguageClient(propsRef.current.language);

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      codeFolding(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      indentUnit.of('  '),
      languageCompartmentRef.current.of(language.editorExtensions() as Extension[]),
      themeCompartmentRef.current.of(editorTheme(isDarkTheme())),
      ...diagnosticsExtensions(),
      // Save is handled here (not only in the keymap) so we can stop the
      // event before the app shell's global Mod-s handler runs it again.
      EditorView.domEventHandlers({
        keydown(event) {
          const mod = event.metaKey || event.ctrlKey;
          if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            propsRef.current.onSave();
            return true;
          }
          return false;
        },
      }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (propsRef.current.onSave(), true) },
        { key: 'Mod-/', preventDefault: true, run: toggleComment },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.contentAttributes.of({
        'aria-label': 'Document source',
        autocapitalize: 'off',
        spellcheck: 'false',
      }),
      placeholder('Start writing…'),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalRef.current) {
          propsRef.current.onChange(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) notifyCursor(update.state);
        if (update.docChanged || update.viewportChanged || update.geometryChanged) scheduleVisible();
      }),
    ];
    extensionsRef.current = extensions;

    const view = new EditorView({
      state: EditorState.create({ doc: propsRef.current.source, extensions }),
      parent: host,
    });
    viewRef.current = view;

    view.dispatch({ effects: setDiagnosticsEffect.of(propsRef.current.diagnostics) });
    notifyCursor(view.state);
    scheduleVisible();

    // Report the visible source range while scrolling so the preview follows.
    const onScroll = () => scheduleVisible();
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // Right click on a block offers its language block actions.
    const onContextMenu = (event: MouseEvent) => {
      const current = propsRef.current;
      if (!current.blocks || current.blocks.length === 0) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return;
      const block = blockAtOffset(current.blocks, pos);
      if (!block) return;
      const actions = current.blockActions(block);
      if (actions.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: EditorSelection.cursor(pos) });
      setMenu({
        x: Math.min(event.clientX, window.innerWidth - 240),
        y: Math.min(event.clientY, window.innerHeight - 220),
        block,
        actions,
      });
    };
    host.addEventListener('contextmenu', onContextMenu);

    return () => {
      host.removeEventListener('contextmenu', onContextMenu);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (visibleFrameRef.current != null) {
        window.cancelAnimationFrame(visibleFrameRef.current);
        visibleFrameRef.current = null;
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------ prop syncing --

  // Controlled source: apply only the real difference so the caret and undo
  // history survive external edits (e.g. an inline edit made in visual mode).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (props.path !== pathRef.current) {
      pathRef.current = props.path;
      replaceDocument(props.source);
      return;
    }
    const current = view.state.doc.toString();
    if (current === props.source) return;
    const splice = minimalSplice(current, props.source, 0);
    if (splice.from === splice.to && splice.insert === '') return;
    applyingExternalRef.current = true;
    try {
      view.dispatch({ changes: { from: splice.from, to: splice.to, insert: splice.insert } });
    } finally {
      applyingExternalRef.current = false;
    }
  }, [props.source, props.path]);

  // Diagnostics arrive with every render.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setDiagnosticsEffect.of(props.diagnostics) });
  }, [props.diagnostics]);

  // Language can change without remounting (e.g. switching from a .typ to a
  // plain file tab).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(
        getLanguageClient(props.language).editorExtensions() as Extension[],
      ),
    });
  }, [props.language]);

  // Follow the app theme attribute / OS colour scheme.
  useEffect(() => {
    const apply = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(editorTheme(isDarkTheme())),
      });
    };
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    media?.addEventListener?.('change', apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media?.removeEventListener?.('change', apply);
      observer.disconnect();
    };
  }, []);

  // Reveal requests from the preview: scroll, select, focus.
  useEffect(() => {
    const reveal = props.reveal;
    const view = viewRef.current;
    if (!reveal || !view) return;
    const length = view.state.doc.length;
    const from = clamp(reveal.range.from, 0, length);
    const to = clamp(reveal.range.to, from, length);
    view.dispatch({
      selection: reveal.select ? EditorSelection.range(from, to) : EditorSelection.cursor(from),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
    // Re-run only when the request nonce changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.nonce]);

  // New render => the block under the caret may have changed.
  useEffect(() => {
    const view = viewRef.current;
    if (view) notifyCursor(view.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.blocks]);

  // Close the context menu on any outside interaction.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (isInsideMenu(event.target)) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menuOpen]);

  function isInsideMenu(target: EventTarget | null): boolean {
    return target instanceof Node && menuRef.current?.contains(target) === true;
  }

  function runMenuAction(action: BlockAction): void {
    const view = viewRef.current;
    if (!menu || !view) return;
    const source = view.state.doc.toString();
    const splice = action.run(source, menu.block);
    setMenu(null);
    if (!splice) return;
    const length = view.state.doc.length;
    const from = clamp(splice.from, 0, length);
    const to = clamp(splice.to, from, length);
    const inserted = splice.insert.length;
    view.dispatch({
      changes: { from, to, insert: splice.insert },
      selection: EditorSelection.cursor(from + inserted),
    });
  }

  // ------------------------------------------------------------------ render --

  const menuStyle: CSSProperties = {
    position: 'fixed',
    left: menu?.x ?? 0,
    top: menu?.y ?? 0,
    zIndex: 2000,
    minWidth: 210,
    padding: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    background: 'var(--bg-elevated-2, var(--bg-elevated))',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
    color: 'var(--fg)',
  };

  return (
    <div
      className="editor-pane"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
        height: '100%',
        background: 'var(--editor-bg)',
        overflow: 'hidden',
      }}
    >
      <div ref={hostRef} style={{ flex: '1 1 auto', minHeight: 0, height: '100%' }} />
      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Block actions"
          style={menuStyle}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            style={{
              padding: '4px 9px 6px',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--fg-subtle)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 220,
            }}
          >
            {menu.block.kind === 'paragraph'
              ? 'Paragraph'
              : `${menu.block.kind[0].toUpperCase()}${menu.block.kind.slice(1)}`}
            {menu.block.label ? ` · ${menu.block.label}` : ''}
          </div>
          {menu.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => runMenuAction(action)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                width: '100%',
                padding: '6px 9px',
                border: 'none',
                borderRadius: 5,
                background: 'transparent',
                color: 'var(--fg)',
                font: 'inherit',
                fontSize: 12,
                textAlign: 'left',
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--hover)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
              }}
            >
              <span>{action.label}</span>
              {action.hint ? (
                <span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{action.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default EditorPane;
