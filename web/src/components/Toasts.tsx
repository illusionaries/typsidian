import type { Toast } from '../store';
import { IconCheck, IconError } from './Icons';

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`toast toast--${toast.kind}`}
          onClick={() => onDismiss(toast.id)}
          title="Dismiss"
        >
          {toast.kind === 'error' ? (
            <IconError size={14} />
          ) : toast.kind === 'success' ? (
            <IconCheck size={14} style={{ color: 'var(--success)' }} />
          ) : null}
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  );
}
