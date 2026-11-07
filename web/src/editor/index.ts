/**
 * Source editor surface public entry point.
 *
 * The shell imports the component directly
 * (`import { EditorPane } from './editor/EditorPane'`); this barrel exists so
 * tests and future tooling can import from `editor/` without caring about file
 * names.
 */

export { EditorPane, default } from './EditorPane';
export type { EditorPaneExtendedProps } from './EditorPane';
export { editorTheme, isDarkTheme } from './theme';
export {
  diagnosticDecorations,
  diagnosticList,
  diagnosticTooltip,
  diagnosticsExtensions,
  setDiagnosticsEffect,
} from './diagnostics';
