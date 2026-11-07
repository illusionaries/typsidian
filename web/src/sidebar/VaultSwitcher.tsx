/**
 * VaultSwitcher — the sidebar header that shows the open vault and switches
 * between recent ones.
 *
 * The component is purely presentational: the shell owns the vault list and
 * performs the API calls (native dialogs live behind `desktop`). It behaves
 * like a small command menu: click to open, Escape / outside click / vault
 * change to close, arrow keys move between items.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { VaultSwitcherProps } from '../contracts';
import { IconChevron, IconClose, IconFolder, IconPlus } from './icons';

/** Compare two filesystem paths the way a user would ("/a/b" == "/a/b/"). */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const trim = (value: string) => value.replace(/\/+$/, '') || '/';
  return trim(a) === trim(b);
}

/** First visible characters of a folder name, for the little avatar. */
function initials(title: string): string {
  const cleaned = title.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
  if (!cleaned) return 'T';
  const words = cleaned.split(/\s+/);
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return [...`${words[0][0]}${words[1][0]}`].join('').toUpperCase();
}

export function VaultSwitcher(props: VaultSwitcherProps) {
  const { title, root, recent, desktop, busy } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  // Close when the vault changes (a successful open/create/close happened).
  useEffect(() => {
    setOpen(false);
  }, [root]);

  // Outside click and Escape close the menu.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const menu = menuRef.current;
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }, []);

  const run = useCallback(
    (action: () => void) => {
      action();
      setOpen(false);
    },
    [],
  );

  const currentRoot = root;

  return (
    <div className="tp-vault" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="tp-vault__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        title={root ?? 'No vault open'}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tp-vault__mark" aria-hidden="true">
          {initials(title)}
        </span>
        <span className="tp-vault__text">
          <span className="tp-vault__title">{title || 'No vault'}</span>
          {root ? <span className="tp-vault__path">{root}</span> : null}
        </span>
        {busy ? (
          <span className="tp-vault__spinner" aria-hidden="true" />
        ) : (
          <span className="tp-vault__chevron" aria-hidden="true">
            <IconChevron />
          </span>
        )}
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="tp-vault__menu"
          role="menu"
          aria-label="Vaults"
          onKeyDown={onMenuKeyDown}
        >
          <div className="tp-vault__section" role="presentation">
            Recent vaults
          </div>

          {recent.length === 0 ? (
            <div className="tp-vault__empty" role="presentation">
              Vaults you open show up here.
            </div>
          ) : (
            recent.map((entry) => {
              const isCurrent = samePath(currentRoot, entry.root);
              return (
                <div
                  key={entry.root}
                  className="tp-vault__row"
                  data-current={isCurrent || undefined}
                  data-missing={!entry.exists || undefined}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="tp-vault__item"
                    disabled={!entry.exists || busy}
                    title={entry.exists ? entry.root : `Folder not found: ${entry.root}`}
                    onClick={() =>
                      run(() => {
                        if (!isCurrent) props.onOpen(entry.root);
                      })
                    }
                  >
                    <span className="tp-vault__item-icon" aria-hidden="true">
                      <IconFolder />
                    </span>
                    <span className="tp-vault__item-text">
                      <span className="tp-vault__item-title">{entry.title}</span>
                      <span className="tp-vault__item-path">{entry.root}</span>
                    </span>
                    {!entry.exists ? (
                      <span className="tp-vault__badge" title="This folder no longer exists">
                        missing
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="tp-vault__remove"
                    title={`Remove ${entry.title} from recent vaults`}
                    aria-label={`Remove ${entry.title} from recent vaults`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onRemoveRecent(entry.root);
                    }}
                  >
                    <IconClose />
                  </button>
                </div>
              );
            })
          )}

          <div className="tp-vault__divider" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="tp-vault__action"
            disabled={busy || !desktop}
            title={desktop ? 'Choose a folder to open as a vault' : 'Available in the desktop app'}
            onClick={() => run(() => props.onChoose())}
          >
            <span className="tp-vault__item-icon" aria-hidden="true">
              <IconFolder />
            </span>
            <span className="tp-vault__action-label">Open folder…</span>
            {!desktop ? <span className="tp-vault__kbd">desktop only</span> : null}
          </button>

          <button
            type="button"
            role="menuitem"
            className="tp-vault__action"
            disabled={busy}
            onClick={() => run(() => props.onCreate())}
          >
            <span className="tp-vault__item-icon" aria-hidden="true">
              <IconPlus />
            </span>
            <span className="tp-vault__action-label">New vault…</span>
          </button>

          {desktop ? (
            <button
              type="button"
              role="menuitem"
              className="tp-vault__action"
              disabled={busy || !root}
              onClick={() => run(() => props.onReveal())}
            >
              <span className="tp-vault__item-icon" aria-hidden="true">
                <IconFolder />
              </span>
              <span className="tp-vault__action-label">Reveal in Finder</span>
            </button>
          ) : null}

          <div className="tp-vault__divider" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="tp-vault__action tp-vault__action--danger"
            disabled={busy || !root}
            onClick={() => run(() => props.onCloseVault())}
          >
            <span className="tp-vault__item-icon" aria-hidden="true">
              <IconClose />
            </span>
            <span className="tp-vault__action-label">Close vault</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default VaultSwitcher;
