/**
 * CodeMirror theme for the source pane.
 *
 * Every colour is a `var(--…)` reference from `web/src/styles.css`, so the
 * editor follows the app's dark/light tokens without a second palette living
 * in TypeScript. The `dark` flag only tells CodeMirror's *base* theme which
 * variant of its structural rules to use; all visible colours are ours.
 */

import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** Whether the app is currently in dark mode (`[data-theme]`, else the OS). */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return true;
  const theme = document.documentElement.dataset.theme;
  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return true;
}

/** Build the CodeMirror theme extension for the given appearance. */
export function editorTheme(dark: boolean = isDarkTheme()): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--editor-bg)',
        color: 'var(--fg)',
        fontSize: '13px',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.7',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '18px 0 42vh',
        caretColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0 20px',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--accent)',
        borderLeftWidth: '2px',
      },
      // drawSelection paints into an overlay layer; `!important` beats the
      // base theme's (very specific) light/dark rules.
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'var(--accent-soft) !important',
        },
      '.cm-gutters': {
        backgroundColor: 'var(--editor-bg)',
        color: 'var(--fg-subtle)',
        border: 'none',
        borderRight: '1px solid var(--border)',
        userSelect: 'none',
      },
      '.cm-gutterElement': {
        padding: '0 10px 0 14px',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        minWidth: '34px',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--hover)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--fg)',
      },
      '.cm-foldGutter .cm-gutterElement': {
        color: 'var(--fg-subtle)',
        cursor: 'pointer',
        padding: '0 4px',
      },
      '.cm-foldGutter .cm-gutterElement:hover': {
        color: 'var(--accent)',
      },
      '.cm-selectionMatch': {
        backgroundColor: 'var(--accent-soft-2, var(--hover))',
      },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--fg)',
        outline: 'none',
      },
      '.cm-placeholder': {
        color: 'var(--fg-subtle)',
      },
      // ------------------------------------------------------- diagnostics --
      '.cm-diag-error': {
        textDecoration: 'underline wavy var(--danger)',
        textDecorationSkipInk: 'none',
        textUnderlineOffset: '3px',
      },
      '.cm-diag-warning': {
        textDecoration: 'underline wavy var(--warning)',
        textDecorationSkipInk: 'none',
        textUnderlineOffset: '3px',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--bg-elevated-2, var(--bg-elevated))',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: 'var(--fg)',
        boxShadow: 'var(--shadow-soft, var(--shadow))',
      },
      '.ts-diagnostic-tooltip': {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '8px 10px',
        maxWidth: '360px',
        fontSize: '12px',
        lineHeight: '1.5',
      },
      '.ts-diagnostic-tooltip__severity': {
        fontSize: '10px',
        fontWeight: '600',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      },
      '.ts-diagnostic-tooltip__severity--error': {
        color: 'var(--danger)',
      },
      '.ts-diagnostic-tooltip__severity--warning': {
        color: 'var(--warning)',
      },
      '.ts-diagnostic-tooltip__message': {
        color: 'var(--fg)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      '.ts-diagnostic-tooltip__hint': {
        color: 'var(--fg-muted)',
      },
      // ------------------------------------------------- search & complete --
      '.cm-panels': {
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--fg)',
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--border)',
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: '1px solid var(--border)',
      },
      '.cm-panel.cm-search': {
        padding: '8px 10px',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px',
      },
      '.cm-textfield': {
        backgroundColor: 'var(--bg-inset, var(--bg))',
        border: '1px solid var(--border)',
        borderRadius: '5px',
        color: 'var(--fg)',
        padding: '2px 6px',
      },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--bg-elevated-2, var(--hover))',
        border: '1px solid var(--border)',
        borderRadius: '5px',
        color: 'var(--fg-muted)',
        padding: '2px 8px',
      },
      '.cm-button:hover': {
        backgroundColor: 'var(--hover-strong, var(--hover))',
        color: 'var(--fg)',
      },
      '.cm-searchMatch': {
        backgroundColor: 'var(--accent-soft)',
        outline: '1px solid var(--accent-strong, var(--accent))',
        borderRadius: '2px',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--accent-strong, var(--accent))',
        color: 'var(--fg-on-accent, var(--fg))',
      },
      '.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-mono)',
        maxHeight: '22em',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--fg)',
      },
      '.cm-completionDetail': {
        color: 'var(--fg-subtle)',
        fontStyle: 'normal',
      },
    },
    { dark },
  );
}
