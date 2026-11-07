/**
 * Server diagnostics as CodeMirror state decorations.
 *
 * The render server already computes precise source ranges (`RenderDiagnostic`
 * carries `range` whenever the engine could locate the problem), so the editor
 * only has to paint them: a wavy underline per severity plus a hover tooltip
 * with the message and hints.
 *
 * Ranges are mapped through document changes, so underlines stay glued to the
 * text they belong to while the user types, until the next render replaces
 * them.
 */

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip } from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import type { RenderDiagnostic } from '../../../shared/doc';

/** Replace the diagnostics shown in the editor. */
export const setDiagnosticsEffect = StateEffect.define<readonly RenderDiagnostic[]>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Decoration positions for one diagnostic range (never empty on purpose). */
function rangeFor(
  state: EditorState,
  diagnostic: RenderDiagnostic,
): { from: number; to: number } | null {
  if (!diagnostic.range) return null;
  const length = state.doc.length;
  let from = clamp(diagnostic.range.from, 0, length);
  let to = clamp(diagnostic.range.to, from, length);
  if (from === to) {
    // Zero-width diagnostics (e.g. "unexpected EOF") still need a visible mark.
    if (to < length) to += 1;
    else if (from > 0) from -= 1;
    else return null;
  }
  return { from, to };
}

function buildDecorations(
  state: EditorState,
  diagnostics: readonly RenderDiagnostic[],
): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const diagnostic of diagnostics) {
    const range = rangeFor(state, diagnostic);
    if (!range) continue;
    const className = diagnostic.severity === 'error' ? 'cm-diag-error' : 'cm-diag-warning';
    ranges.push({ ...range, decoration: Decoration.mark({ class: className }) });
  }
  // RangeSetBuilder requires ascending, deterministic order.
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}

/**
 * What the editor paints: the underline decorations.
 */
export const diagnosticDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        return buildDecorations(transaction.state, effect.value);
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function mapDiagnostic(
  diagnostic: RenderDiagnostic,
  changes: { mapPos: (pos: number, assoc?: number) => number },
): RenderDiagnostic {
  if (!diagnostic.range) return diagnostic;
  const from = changes.mapPos(diagnostic.range.from, -1);
  const to = Math.max(from, changes.mapPos(diagnostic.range.to, 1));
  return { ...diagnostic, range: { from, to } };
}

/**
 * The diagnostics themselves, kept mapped for the hover tooltip.
 */
export const diagnosticList = StateField.define<readonly RenderDiagnostic[]>({
  create: () => [],
  update(list, transaction) {
    let next = list;
    if (transaction.docChanged) {
      next = next.map((diagnostic) => mapDiagnostic(diagnostic, transaction.changes));
    }
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnosticsEffect)) next = effect.value;
    }
    return next;
  },
});

/** Tooltip describing the diagnostic under the pointer. */
export const diagnosticTooltip = hoverTooltip(
  (view, pos): Tooltip | null => {
    const diagnostics = view.state.field(diagnosticList, false);
    if (!diagnostics || diagnostics.length === 0) return null;
    const hit = diagnostics.find((diagnostic) => {
      const range = rangeFor(view.state, diagnostic);
      return range != null && pos >= range.from && pos <= range.to;
    });
    if (!hit) return null;
    const range = rangeFor(view.state, hit);
    if (!range) return null;
    return {
      pos: range.from,
      end: range.to,
      above: true,
      create(): { dom: HTMLElement } {
        const dom = document.createElement('div');
        dom.className = 'ts-diagnostic-tooltip';

        const severity = document.createElement('div');
        severity.className = `ts-diagnostic-tooltip__severity ts-diagnostic-tooltip__severity--${hit.severity}`;
        severity.textContent = hit.severity === 'error' ? 'Error' : 'Warning';
        dom.append(severity);

        const message = document.createElement('div');
        message.className = 'ts-diagnostic-tooltip__message';
        message.textContent = hit.message;
        dom.append(message);

        for (const hint of hit.hints ?? []) {
          const hintElement = document.createElement('div');
          hintElement.className = 'ts-diagnostic-tooltip__hint';
          hintElement.textContent = hint;
          dom.append(hintElement);
        }
        return { dom };
      },
    };
  },
  { hideOnChange: true, hoverTime: 120 },
);

/** All diagnostic extensions the editor pane installs. */
export function diagnosticsExtensions(): Extension[] {
  return [diagnosticDecorations, diagnosticList, diagnosticTooltip];
}
