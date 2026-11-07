import type { StatusBarProps } from '../contracts';
import { IconError, IconWarning } from './Icons';

export function StatusBar(props: StatusBarProps) {
  const errors = props.diagnostics.filter((entry) => entry.severity === 'error').length;
  const warnings = props.diagnostics.length - errors;
  return (
    <footer className="statusbar">
      <span className="statusbar__item" title={props.path ?? ''}>
        {props.path ?? 'No document'}
      </span>
      <span className="statusbar__item">{props.language}</span>
      <span className="statusbar__item" title="Cursor position">
        Ln {props.cursor.line}, Col {props.cursor.column}
      </span>
      <span className="statusbar__spacer" />

      {props.pending ? (
        <span className="statusbar__progress">
          <span className="spinner" /> typesetting…
        </span>
      ) : (
        <span className="statusbar__item" title="Last render time">
          {props.renderMs.toFixed(0)} ms
        </span>
      )}

      <span className="statusbar__item">{props.blockCount} blocks</span>
      <span className="statusbar__item">
        {props.pageCount} {props.pageCount === 1 ? 'page' : 'pages'}
      </span>
      <span className="statusbar__item">
        {props.wordCount} {props.wordCount === 1 ? 'word' : 'words'}
      </span>

      <button
        className={`statusbar__item statusbar__item--button ${
          errors > 0 ? 'statusbar__item--danger' : warnings > 0 ? 'statusbar__item--warning' : ''
        }`}
        title="Toggle diagnostics"
        onClick={props.onToggleDiagnostics}
      >
        {errors > 0 ? <IconError size={12} /> : warnings > 0 ? <IconWarning size={12} /> : null}
        {errors > 0 ? `${errors} error${errors > 1 ? 's' : ''}` : null}
        {errors > 0 && warnings > 0 ? ' · ' : null}
        {warnings > 0 ? `${warnings} warning${warnings > 1 ? 's' : ''}` : null}
        {errors === 0 && warnings === 0 ? 'no problems' : null}
      </button>

      <span className="statusbar__item" title="Current mode">
        {props.mode}
      </span>
    </footer>
  );
}
