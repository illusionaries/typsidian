/**
 * Inline path prompt used by the welcome screen when the app runs in a plain
 * browser (no native folder dialog). The Electron build never needs this: the
 * shell opens an OS folder picker instead.
 *
 * The prompt is a small modal: type an absolute path, press ↵, done. It keeps
 * the path between openings so a failed attempt can be corrected quickly.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react';

import { IconAlert, IconArrowRight, IconFolderOpen } from './icons';

export interface PathPromptProps {
  initialPath?: string;
  busy: boolean;
  /** Directory where the app keeps its config; shown as a gentle hint. */
  home: string;
  onSubmit(path: string): void;
  onClose(): void;
}

/** Whether a typed path looks absolute (POSIX, home-relative or Windows). */
export function isAbsolutePath(value: string): boolean {
  const path = value.trim();
  if (!path) return false;
  if (path.startsWith('/') || path.startsWith('~/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true;
  return /^\\\\[^\\]+\\/.test(path);
}

export function PathPrompt({ initialPath = '', busy, home, onSubmit, onClose }: PathPromptProps) {
  const [value, setValue] = useState(initialPath);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const trimmed = value.trim();
  const absolute = trimmed === '' || isAbsolutePath(trimmed);
  const invalid = touched && !absolute;
  const canSubmit = trimmed.length > 0 && absolute && !busy;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    if (!absolute) {
      inputRef.current?.focus();
      return;
    }
    if (busy) return;
    onSubmit(trimmed);
  };

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="welcome-modal" onMouseDown={onBackdropMouseDown}>
      <form
        className="welcome-modal__card"
        role="dialog"
        aria-modal="true"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          // Keep Tab inside the dialog: focus must never reach the page behind.
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled])',
            ),
          ).filter((element) => element.offsetParent !== null);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement as HTMLElement | null;
          if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        aria-labelledby={`${inputId}-title`}
      >
        <div className="welcome-modal__head">
          <span className="welcome-modal__mark" aria-hidden="true">
            <IconFolderOpen size={20} />
          </span>
          <div className="welcome-modal__heading">
            <h2 className="welcome-modal__title" id={`${inputId}-title`}>
              Open a vault folder
            </h2>
            <p className="welcome-modal__subtitle">
              Type the absolute path of a folder with your <code>.typ</code> notes.
            </p>
          </div>
          <button
            type="button"
            className="welcome-modal__close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <label className="welcome-modal__label" htmlFor={inputId}>
          Folder path
        </label>
        <div
          className={`welcome-modal__field${invalid ? ' welcome-modal__field--invalid' : ''}`}
        >
          <span className="welcome-modal__prompt" aria-hidden="true">
            <IconFolderOpen size={15} />
          </span>
          <input
            ref={inputRef}
            id={inputId}
            className="welcome-modal__input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setTouched(true);
            }}
            placeholder="e.g. /Users/you/Documents/notes"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            disabled={busy}
          />
          <button
            type="submit"
            className="welcome-modal__submit"
            disabled={!canSubmit}
            title={canSubmit ? 'Open vault (↵)' : 'Enter an absolute path'}
          >
            Open
            <IconArrowRight size={14} />
          </button>
        </div>

        {invalid ? (
          <p className="welcome-modal__error" id={errorId} role="alert">
            <IconAlert size={13} />
            That is not an absolute path. It should start with <code>/</code> or <code>~/</code>.
          </p>
        ) : (
          <p className="welcome-modal__hint">
            Vaults are plain folders — any folder with <code>.typ</code> files works.
            <span className="welcome-modal__hint-home" title={home}>
              {' '}
              config lives in <code>{shorten(home)}</code>
            </span>
          </p>
        )}

        <div className="welcome-modal__actions">
          <span className="welcome-modal__keys">
            <kbd>esc</kbd> cancel
            <span className="welcome-modal__keys-sep" />
            <kbd>↵</kbd> open
          </span>
          <span className="welcome-modal__spacer" />
          <button type="button" className="welcome-modal__button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function shorten(path: string): string {
  if (path.length <= 48) return path;
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}
