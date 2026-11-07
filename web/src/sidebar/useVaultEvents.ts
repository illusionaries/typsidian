/**
 * Subscribe to the server's vault-change stream (`GET /api/events`, SSE).
 *
 * The hook owns the `EventSource` lifecycle, coalesces bursts into one
 * callback per animation-sized window and survives reconnects (the browser
 * retries automatically; we expose `connected` so the shell can show a hint).
 */

import { useEffect, useRef, useState } from 'react';

export type VaultEventType = 'change' | 'add' | 'unlink';

export interface VaultEvent {
  type: VaultEventType;
  /** Vault-relative path, POSIX separators. */
  path: string;
}

export interface UseVaultEventsOptions {
  /** Pause the subscription without unmounting the consumer. Default true. */
  enabled?: boolean;
  /** Coalescing window in milliseconds. Default 60. */
  coalesceMs?: number;
  /** EventSource endpoint. Default `/api/events`. */
  url?: string;
}

export interface VaultEventsState {
  /** True while the stream is open. */
  connected: boolean;
  /** Epoch ms of the last batch, or null. */
  lastEventAt: number | null;
}

function isVaultEvent(value: unknown): value is VaultEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; path?: unknown };
  return (
    (candidate.type === 'change' || candidate.type === 'add' || candidate.type === 'unlink') &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0
  );
}

/**
 * Call `onEvents` with batched vault changes. The callback may change between
 * renders without reopening the connection.
 *
 * ```tsx
 * useVaultEvents((events) => {
 *   if (events.some((event) => event.type !== 'change')) void store.refreshWorkspace();
 * });
 * ```
 */
export function useVaultEvents(
  onEvents: (events: VaultEvent[]) => void,
  options: UseVaultEventsOptions = {},
): VaultEventsState {
  const { enabled = true, coalesceMs = 60, url = '/api/events' } = options;
  const callbackRef = useRef(onEvents);
  callbackRef.current = onEvents;

  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return undefined;
    }

    let source: EventSource | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Map<string, VaultEvent>();

    const flush = (): void => {
      flushTimer = null;
      if (pending.size === 0) return;
      const events = [...pending.values()];
      pending.clear();
      setLastEventAt(Date.now());
      callbackRef.current(events);
    };

    const queue = (event: VaultEvent): void => {
      // Last event per path wins inside one coalescing window.
      pending.set(event.path, event);
      if (flushTimer !== null) return;
      flushTimer = setTimeout(flush, Math.max(0, coalesceMs));
    };

    try {
      source = new EventSource(url);
    } catch {
      return undefined;
    }

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      // EventSource reconnects on its own; just reflect the state.
      setConnected(false);
    };
    source.onmessage = (message: MessageEvent<string>) => {
      if (!message.data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data) as unknown;
      } catch {
        return;
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (isVaultEvent(item)) queue(item);
      }
    };

    return () => {
      source?.close();
      if (flushTimer !== null) clearTimeout(flushTimer);
      pending.clear();
      setConnected(false);
    };
  }, [enabled, coalesceMs, url]);

  return { connected, lastEventAt };
}
