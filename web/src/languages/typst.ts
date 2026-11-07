/**
 * Typst — the *light* (client) half of the language plugin.
 *
 * Everything here is pure with respect to the source string: no DOM, no IO,
 * no React. That keeps block edits testable in plain Node and makes visual
 * mode instant — the server is only ever asked for renders.
 *
 * The CodeMirror half is built on `codemirror-lang-typst/lezer`, the WASM-free
 * Lezer parser shipped by the same package. We assemble the `LanguageSupport`
 * ourselves (instead of calling `typst_lezer()`) for two reasons:
 *
 *  1. the package's bundled highlight style is hard-coded to the official
 *     Typst *light* palette, while Typsidian themes through CSS variables and
 *     ships a dark theme by default;
 *  2. we don't want the package's own linter — server diagnostics are the
 *     authoritative ones and are rendered by the editor pane itself.
 */

import { HighlightStyle, Language, LanguageSupport, languageDataProp, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  typstLanguageData,
  typstLezerFoldService,
  typstLezerFolding,
  typstLezerHighlighting,
  typstLezerIndentService,
  typstLezerIndentation,
  typstLezerListKeymap,
  typstParser,
  typstTags,
} from 'codemirror-lang-typst/lezer';

import type { BlockAction, DocBlock, LanguageClient, SourceSplice } from '../../../shared/doc';
import { blockText, minimalSplice } from '../../../shared/doc';

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

/**
 * Typst tokens mapped onto the app's design tokens.
 *
 * `HighlightStyle` emits real CSS, so referencing `var(--… )` here means the
 * editor follows `styles.css` when the user flips `[data-theme]` — no
 * reconfiguration, no JS colour table.
 */
export const typstHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--fg-subtle, #8b8998)', fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--fg-muted, #a6a4b3)' },
  { tag: tags.heading, color: 'var(--fg, #ecebf1)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--fg, #ecebf1)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--fg, #ecebf1)', fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--accent, #a78bfa)', textDecoration: 'underline' },
  { tag: [tags.labelName, tags.escape], color: 'var(--warning, #fbbf24)' },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.bool, tags.null, tags.atom],
    color: 'var(--danger, #f87171)',
  },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--warning, #fbbf24)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--success, #34d399)' },
  {
    tag: [tags.function(tags.variableName), tags.className, tags.typeName],
    color: 'var(--accent, #a78bfa)',
  },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--fg-muted, #a6a4b3)' },
  { tag: typstTags.mathDelimiter, color: 'var(--accent, #a78bfa)' },
  { tag: typstTags.listMarker, color: 'var(--accent, #a78bfa)' },
  { tag: typstTags.interpolated, color: 'var(--success, #34d399)' },
  {
    tag: [tags.operator, tags.punctuation, tags.paren, tags.squareBracket, tags.brace],
    color: 'var(--fg-muted, #a6a4b3)',
  },
  { tag: tags.variableName, color: 'var(--fg, #ecebf1)' },
  { tag: tags.invalid, color: 'var(--danger, #f87171)', textDecoration: 'underline wavy' },
]);

// ---------------------------------------------------------------------------
// CodeMirror language support
// ---------------------------------------------------------------------------

let cachedSupport: LanguageSupport | null = null;

function buildTypstSupport(): LanguageSupport {
  // Attach the language data facet (comment tokens, autocomplete source) and
  // the highlighting / indent / fold node props from the package.
  const parser = typstParser.configure([
    languageDataProp.add((type) => (type.isTop ? typstLanguageData : undefined)),
    typstLezerHighlighting,
    typstLezerIndentation,
    typstLezerFolding,
  ]);
  const language = new Language(typstLanguageData, parser, [], 'typst');
  return new LanguageSupport(language, [
    syntaxHighlighting(typstHighlightStyle),
    typstLezerIndentService,
    typstLezerFoldService,
    typstLezerListKeymap,
  ]);
}

/** The (cached) CodeMirror language support for Typst. */
export function typstLanguageSupport(): LanguageSupport {
  cachedSupport ??= buildTypstSupport();
  return cachedSupport;
}

// ---------------------------------------------------------------------------
// Markup helpers (pure)
// ---------------------------------------------------------------------------

const HEADING_PREFIX = /^[ \t]*(={1,6})[ \t]+/;
const LIST_PREFIX = /^[ \t]*(?:[-+]|\d+[.)])[ \t]+/;
const RAW_FENCE = /^[ \t]*(`{3,}|~{3,})[^`\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/;
const DISPLAY_MATH = /^\$[ \t]*([\s\S]*?)[ \t]*\$$/;

/** Remove a heading's `= ` marker(s), keeping the text. */
export function stripHeadingMarker(text: string): string {
  return text.replace(HEADING_PREFIX, '');
}

/** The marker (e.g. `"== "`) a heading block currently carries. */
export function headingMarkerOf(text: string, block?: Pick<DocBlock, 'level'>): string {
  if (block?.level) return `${'='.repeat(block.level)} `;
  const match = HEADING_PREFIX.exec(text);
  return match ? `${match[1]} ` : '= ';
}

function stripFence(text: string): string {
  const match = RAW_FENCE.exec(text);
  return match ? match[2] : text;
}

function stripDisplayMath(text: string): string {
  const match = DISPLAY_MATH.exec(text.trim());
  return match ? match[1] : text.trim();
}

function listBody(line: string): string {
  return line.trim().replace(LIST_PREFIX, '');
}

function eachLine(text: string, transform: (line: string, index: number) => string): string {
  return text.split('\n').map(transform).join('\n');
}

/** Wrap/unwrap a whole block in an inline marker (`*`, `_`, `` ` ``). */
function toggleInline(text: string, marker: string): string {
  const body = text.trim();
  if (body.length > marker.length * 2 && body.startsWith(marker) && body.endsWith(marker)) {
    return body.slice(marker.length, body.length - marker.length);
  }
  return `${marker}${body}${marker}`;
}

// ---------------------------------------------------------------------------
// Block actions
// ---------------------------------------------------------------------------

type BlockTransform = (text: string, block: DocBlock) => string | null;

/**
 * Turn a pure `oldText -> newText` transform into a `BlockAction`: the action
 * itself only ever returns a splice, never touches the document.
 */
function makeAction(
  id: string,
  label: string,
  hint: string | undefined,
  transform: BlockTransform,
): BlockAction {
  return {
    id,
    label,
    hint,
    run(source: string, block: DocBlock): SourceSplice | null {
      const oldText = blockText(source, block);
      const next = transform(oldText, block);
      if (next === null || next === oldText) return null;
      return minimalSplice(oldText, next, block.range.from);
    },
  };
}

function headingAction(level: number): BlockAction {
  return makeAction(`heading-${level}`, `Heading ${level}`, undefined, (text, block) => {
    const body = block.kind === 'heading' ? stripHeadingMarker(text) : text.trim();
    return `${'='.repeat(level)} ${body}`;
  });
}

const headingActions: BlockAction[] = [headingAction(1), headingAction(2), headingAction(3)];

const paragraphAction = makeAction('paragraph', 'Paragraph', undefined, (text, block) => {
  if (block.kind !== 'heading') return null;
  return stripHeadingMarker(text);
});

const bulletAction = makeAction('list-bullet', 'Bullet list', undefined, (text) =>
  eachLine(text, (line) => {
    if (!line.trim()) return '';
    return `- ${listBody(line)}`;
  }),
);

const numberedAction = makeAction('list-numbered', 'Numbered list', undefined, (text) =>
  eachLine(text, (line) => {
    if (!line.trim()) return '';
    return `+ ${listBody(line)}`;
  }),
);

const codeBlockAction = makeAction('code-block', 'Code block', undefined, (text) => {
  const body = stripFence(text);
  if (body === text && /^[ \t]*(`{3,}|~{3,})/.test(text)) return null;
  return `\`\`\`\n${body}\n\`\`\``;
});

const equationAction = makeAction('display-equation', 'Display equation', undefined, (text) => {
  const body = stripDisplayMath(text);
  return `$ ${body} $`;
});

const quoteAction = makeAction('quote', 'Block quote', undefined, (text) => {
  const body = eachLine(text.trim(), (line) => `  ${line}`);
  return `#quote(block: true)[\n${body}\n]`;
});

const boldAction = makeAction('inline-bold', 'Bold', '⌘B', (text) => toggleInline(text, '*'));
const italicAction = makeAction('inline-italic', 'Italic', '⌘I', (text) => toggleInline(text, '_'));
const inlineCodeAction = makeAction('inline-code', 'Inline code', '⌘E', (text) => toggleInline(text, '`'));

const TEXTUAL_KINDS: ReadonlySet<string> = new Set(['paragraph', 'other', 'raw']);

/**
 * Actions offered for a block (bullets, heading levels, …).
 *
 * These are deliberately block-scoped: they only need `source` + `block`, so
 * the visual editor can render a toolbar and the split editor a context menu
 * from the same data.
 */
export function typstBlockActions(_source: string, block: DocBlock): BlockAction[] {
  const kind = block.kind;
  if (kind === 'heading') {
    return [...headingActions, paragraphAction];
  }
  if (kind === 'paragraph') {
    return [
      ...headingActions,
      bulletAction,
      numberedAction,
      codeBlockAction,
      equationAction,
      quoteAction,
      boldAction,
      italicAction,
      inlineCodeAction,
    ];
  }
  if (TEXTUAL_KINDS.has(kind) || kind === 'quote') {
    return [...headingActions, bulletAction, numberedAction, codeBlockAction, equationAction, quoteAction];
  }
  if (kind === 'list') {
    return [bulletAction, numberedAction, codeBlockAction];
  }
  if (kind === 'math') {
    return [equationAction];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Block text editing
// ---------------------------------------------------------------------------

/** Split a fenced raw block into its fence lines and body. */
function splitFence(text: string): { open: string; body: string; close: string } | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const open = /^\s*(`{3,}|~{3,}).*$/.exec(lines[0]);
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[lines.length - 1]);
  if (!open || !close) return null;
  const fence = open[1][0];
  if (close[1][0] !== fence) return null;
  return {
    open: lines[0],
    body: lines.slice(1, -1).join('\n'),
    close: lines[lines.length - 1],
  };
}

/** Split a display equation block into its `$` delimiters and body. */
function splitDisplayMath(text: string): { left: string; body: string; right: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('$ ') || !trimmed.endsWith(' $')) return null;
  return { left: '$ ', body: trimmed.slice(2, -2), right: ' $' };
}

/** Text to show in the inline (visual mode) editor for a block. */
export function typstEditableText(source: string, block: DocBlock): string {
  const text = blockText(source, block);
  switch (block.kind) {
    case 'heading':
      return stripHeadingMarker(text);
    case 'paragraph':
      return text.trim();
    case 'code': {
      const fenced = splitFence(text);
      return fenced ? fenced.body : text;
    }
    case 'math': {
      const equation = splitDisplayMath(text);
      return equation ? equation.body : text;
    }
    default:
      return text;
  }
}

/** Replace a block's content with `newText`, preserving syntactic decoration. */
export function typstSpliceBlockEdit(
  source: string,
  block: DocBlock,
  newText: string,
): SourceSplice {
  const oldText = blockText(source, block);
  let next: string;
  switch (block.kind) {
    case 'heading': {
      const marker = headingMarkerOf(oldText, block);
      next = `${marker}${stripHeadingMarker(newText)}`;
      break;
    }
    case 'paragraph':
      next = newText.trim();
      break;
    case 'code': {
      const fenced = splitFence(oldText);
      next = fenced ? `${fenced.open}\n${newText}\n${fenced.close}` : newText;
      break;
    }
    case 'math': {
      const equation = splitDisplayMath(oldText);
      next = equation ? `${equation.left}${newText.trim()}${equation.right}` : newText;
      break;
    }
    default:
      next = newText;
      break;
  }
  return minimalSplice(oldText, next, block.range.from);
}

// ---------------------------------------------------------------------------
// The client half
// ---------------------------------------------------------------------------

export const typstLanguageClient: LanguageClient = {
  id: 'typst',
  modeName: 'Typst',

  spliceBlockEdit: typstSpliceBlockEdit,
  editableText: typstEditableText,
  actions: typstBlockActions,
  editorExtensions(): unknown[] {
    return [typstLanguageSupport()];
  },
};

export default typstLanguageClient;
