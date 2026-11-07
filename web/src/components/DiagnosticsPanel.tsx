import type { RenderDiagnostic } from '../../../shared/doc';
import { lineColumn } from '../../../shared/doc';
import { IconCheck, IconError, IconWarning } from './Icons';

export interface DiagnosticsPanelProps {
  diagnostics: RenderDiagnostic[];
  source: string;
  onJump(diagnostic: RenderDiagnostic): void;
  onClose(): void;
}

export function DiagnosticsPanel({ diagnostics, source, onJump, onClose }: DiagnosticsPanelProps) {
  return (
    <section className="diagnostics-panel" aria-label="Diagnostics">
      <div className="diagnostics-panel__head">
        <span>Problems</span>
        <span className="badge">{diagnostics.length}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-button" title="Close" onClick={onClose} style={{ width: 22, height: 22 }}>
          <IconCheck />
        </button>
      </div>
      <div className="diagnostics-panel__list">
        {diagnostics.length === 0 ? (
          <div style={{ padding: '10px 8px', color: 'var(--fg-subtle)', fontSize: 12 }}>
            No problems detected.
          </div>
        ) : (
          diagnostics.map((diagnostic, index) => {
            const where = diagnostic.range
              ? lineColumn(source, diagnostic.range.from)
              : null;
            return (
              <button
                key={`${diagnostic.message}-${index}`}
                className="diagnostic-row"
                onClick={() => onJump(diagnostic)}
                title={diagnostic.hints.join('\n') || diagnostic.message}
              >
                <span className="diagnostic-row__icon">
                  {diagnostic.severity === 'error' ? (
                    <IconError size={13} style={{ color: 'var(--danger)' }} />
                  ) : (
                    <IconWarning size={13} style={{ color: 'var(--warning)' }} />
                  )}
                </span>
                <span className="diagnostic-row__text">{diagnostic.message}</span>
                {where ? (
                  <span className="diagnostic-row__where">
                    {where.line}:{where.column}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
