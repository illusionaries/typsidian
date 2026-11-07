/**
 * WelcomeScreen — the landing screen of the standalone app.
 *
 * Shown whenever no vault is open. It is deliberately language-agnostic (it
 * only knows about "vaults" = folders of notes) and draws everything from the
 * shell design tokens, so it inherits the dark and light themes.
 *
 * Three layers, top to bottom:
 *   1. hero: mark, wordmark, tagline;
 *   2. actions: open / new / sample, then the recent-vault list;
 *   3. footer: version, config directory and keyboard hints.
 *
 * In a plain browser there is no native folder dialog, so "Open vault…" opens
 * an inline path prompt instead (see PathPrompt).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WelcomeScreenProps } from '../contracts';
import {
  IconAlert,
  IconClose,
  IconEnter,
  IconFolderMissing,
  IconFolderOpen,
  IconFolderPlus,
  IconHome,
  IconSparkles,
  IconVault,
} from './icons';
import { PathPrompt } from './PathPrompt';
import './welcome.css';

export function WelcomeScreen(props: WelcomeScreenProps) {
  const { recent, version, home, desktop, busy, error, sampleAvailable } = props;

  const [promptOpen, setPromptOpen] = useState(false);
  /** Last typed path, kept across prompt openings so retrying is cheap. */
  const lastPathRef = useRef('');
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const promptOpenRef = useRef(promptOpen);
  promptOpenRef.current = promptOpen;

  /** Latest props/handlers for the window-level key handler. */
  const latest = useRef(props);
  latest.current = props;

  /** Wall clock used to keep relative timestamps fresh. */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // ------------------------------------------------------------- actions ---

  const openFolder = useCallback(() => {
    const current = latest.current;
    if (current.busy) return;
    if (current.desktop) current.onChooseFolder();
    else setPromptOpen(true);
  }, []);

  const closePrompt = useCallback(() => {
    setPromptOpen(false);
    // Return keyboard focus to the action that opened the prompt.
    window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
  }, []);

  const submitPath = useCallback(
    (path: string) => {
      lastPathRef.current = path;
      setPromptOpen(false);
      window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
      latest.current.onOpenPath(path);
    },
    [],
  );

  const removeRecent = useCallback((path: string) => {
    latest.current.onRemoveRecent(path);
  }, []);

  // ------------------------------------------------------------ keyboard ---

  const focusables = useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-welcome-focusable="true"]')).filter(
      (element) => element.offsetParent !== null && !element.hasAttribute('disabled'),
    );
  }, []);

  const moveFocus = useCallback(
    (delta: number) => {
      const items = focusables();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = active ? items.indexOf(active) : -1;
      const next = index === -1 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length;
      items[next]?.focus();
    },
    [focusables],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && !event.altKey && event.key.toLowerCase() === 'o') {
        // In the desktop app the native application menu owns ⌘O; only the
        // browser build needs a renderer-side shortcut for the path prompt.
        if (current.desktop) return;
        event.preventDefault();
        if (promptOpenRef.current || current.busy) return;
        openFolder();
        return;
      }

      if (promptOpenRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePrompt();
        }
        return;
      }
      if (current.busy) return;

      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (event.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        const interactive =
          !!active && (active.tagName === 'BUTTON' || active.tagName === 'A' || active.tagName === 'INPUT');
        if (interactive) return; // native activation handles it
        const choice = current.recent.find((vault) => vault.exists) ?? current.recent[0];
        if (!choice) return;
        event.preventDefault();
        current.onOpenRecent(choice.root);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePrompt, moveFocus, openFolder]);

  // ---------------------------------------------------------------- view ---

  const versionLabel = version ? (version.startsWith('v') ? version : `v${version}`) : '';

  return (
    <div
      ref={rootRef}
      className={`welcome${busy ? ' welcome--busy' : ''}`}
      aria-busy={busy || undefined}
    >
      <div className="welcome__drag" aria-hidden="true" />
      <div className="welcome__aurora" aria-hidden="true">
        <span className="welcome__glow welcome__glow--a" />
        <span className="welcome__glow welcome__glow--b" />
      </div>

      <main className="welcome__main">
        <header className="welcome__hero">
          <div className="welcome__mark" aria-hidden="true">
            T
          </div>
          <div className="welcome__titles">
            <h1 className="welcome__name">Typsidian</h1>
            <p className="welcome__tagline">
              An Obsidian-like editor for <span className="welcome__tagline-accent">Typst</span>
            </p>
          </div>
        </header>

        <section className="welcome__actions" aria-label="Open a vault">
          <button
            ref={primaryRef}
            type="button"
            className="welcome-action welcome-action--primary"
            data-welcome-focusable="true"
            disabled={busy}
            onClick={openFolder}
            title={
              desktop
                ? 'Choose a folder to open as a vault (⌘O)'
                : 'Open a vault by absolute path (⌘O)'
            }
          >
            {busy ? (
              <span className="welcome__spinner" aria-hidden="true" />
            ) : (
              <IconFolderOpen size={17} />
            )}
            <span className="welcome-action__label">
              {busy ? 'Working…' : desktop ? 'Open folder…' : 'Open vault…'}
            </span>
            {!busy && !desktop ? (
              <kbd className="welcome-action__kbd" aria-hidden="true">
                ⌘O
              </kbd>
            ) : null}
          </button>

          <button
            type="button"
            className="welcome-action"
            data-welcome-focusable="true"
            disabled={busy}
            onClick={() => props.onCreateVault()}
            title="Create a new vault folder"
          >
            <IconFolderPlus size={17} />
            <span className="welcome-action__label">New vault…</span>
          </button>

          {sampleAvailable ? (
            <button
              type="button"
              className="welcome-action welcome-action--sample"
              data-welcome-focusable="true"
              disabled={busy}
              onClick={() => props.onOpenSample()}
              title="Open the bundled sample vault"
            >
              <IconSparkles size={17} />
              <span className="welcome-action__label">Try the sample vault</span>
            </button>
          ) : null}
        </section>

        {error ? (
          <div className="welcome__error" role="alert">
            <span className="welcome__error-icon" aria-hidden="true">
              <IconAlert size={16} />
            </span>
            <div className="welcome__error-body">
              <span className="welcome__error-title">Something went wrong</span>
              <span className="welcome__error-text">{error}</span>
            </div>
          </div>
        ) : null}

        <section className="welcome__recents" aria-labelledby="welcome-recents-title">
          <div className="welcome__section-head">
            <h2 className="welcome__section-title" id="welcome-recents-title">
              Recent vaults
            </h2>
            {recent.length > 0 ? <span className="welcome__count">{recent.length}</span> : null}
          </div>

          {recent.length === 0 ? (
            <div className="welcome__empty">
              <span className="welcome__empty-icon" aria-hidden="true">
                <IconVault size={21} />
              </span>
              <span className="welcome__empty-title">No recent vaults yet</span>
              <span className="welcome__empty-hint">
                {desktop
                  ? 'Choose a folder to get started — it will show up here next time.'
                  : 'Open a folder by path to get started. Recent vaults show up here.'}
              </span>
            </div>
          ) : (
            <ul className="welcome__list">
              {recent.map((vault) => (
                <li className="welcome__row-item" key={vault.root}>
                  <button
                    type="button"
                    className={`welcome__row${vault.exists ? '' : ' welcome__row--missing'}`}
                    data-welcome-focusable="true"
                    disabled={busy}
                    onClick={() => props.onOpenRecent(vault.root)}
                    title={
                      vault.exists
                        ? `Open ${vault.root}`
                        : `${vault.root} — folder is missing, click to pick it again`
                    }
                  >
                    <span className="welcome__row-icon" aria-hidden="true">
                      {vault.exists ? <IconVault size={17} /> : <IconFolderMissing size={17} />}
                    </span>
                    <span className="welcome__row-body">
                      <span className="welcome__row-title">
                        <span className="welcome__row-name">{vaultTitle(vault)}</span>
                        {vault.exists ? null : <span className="welcome__row-badge">folder missing</span>}
                      </span>
                      <span className="welcome__row-path">{vault.root}</span>
                    </span>
                    <span className="welcome__row-time" title={absoluteTime(vault.lastOpened)}>
                      {relativeTime(vault.lastOpened, now)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="welcome__row-remove"
                    onClick={() => removeRecent(vault.root)}
                    aria-label={`Remove ${vaultTitle(vault)} from recent vaults`}
                    title="Remove from recent vaults"
                  >
                    <IconClose size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="welcome__footer">
        <span className="welcome__footer-version">
          Typsidian{versionLabel ? ` ${versionLabel}` : ''}
        </span>
        {desktop ? null : <span className="welcome__footer-badge">browser</span>}
        <span className="welcome__footer-divider" aria-hidden="true" />
        <span className="welcome__footer-home" title={home || 'no config directory'}>
          <IconHome size={12} />
          <span>{home || 'no config directory'}</span>
        </span>
        <span className="welcome__footer-spacer" />
        <span className="welcome__footer-hints">
          {recent.length > 0 ? (
            <span className="welcome__hint">
              <IconEnter size={12} />
              <kbd>↵</kbd> open first
            </span>
          ) : null}
          <span className="welcome__hint">
            <kbd>⌘O</kbd> open vault
          </span>
        </span>
      </footer>

      {promptOpen ? (
        <PathPrompt
          initialPath={lastPathRef.current}
          busy={busy}
          home={home}
          onSubmit={submitPath}
          onClose={closePrompt}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

let relativeFormatter: Intl.RelativeTimeFormat | null = null;

function formatter(): Intl.RelativeTimeFormat | null {
  if (relativeFormatter) return relativeFormatter;
  try {
    relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  } catch {
    relativeFormatter = null;
  }
  return relativeFormatter;
}

/** "2 hours ago" style relative time for a recent-vault timestamp. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (diff < 45_000) return 'just now';

  const relative = formatter();
  const format = (value: number, unit: Intl.RelativeTimeFormatUnit): string => {
    if (relative) {
      try {
        return relative.format(value, unit);
      } catch {
        /* fall through to the absolute label */
      }
    }
    return absoluteTime(timestamp);
  };

  if (diff < 45 * minute) return format(-Math.round(diff / minute), 'minute');
  if (diff < 22 * hour) return format(-Math.round(diff / hour), 'hour');
  if (diff < 40 * hour) return format(-1, 'day');
  if (diff < 7 * day) return format(-Math.round(diff / day), 'day');
  if (diff < 30 * day) return format(-Math.round(diff / (7 * day)), 'week');
  if (diff < 365 * day) return format(-Math.round(diff / (30 * day)), 'month');
  return format(-Math.round(diff / (365 * day)), 'year');
}

/** Display name for a recent vault, falling back to the folder name. */
export function vaultTitle(vault: { title: string; root: string }): string {
  const title = vault.title?.trim();
  if (title) return title;
  const parts = vault.root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? vault.root;
}

/** Full timestamp for tooltips, or an empty string when unknown. */
export function absoluteTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Date(timestamp).toLocaleString('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(timestamp).toString();
  }
}

export default WelcomeScreen;
