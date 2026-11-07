/**
 * Language registry.
 *
 * Adding a language = adding an adapter here plus its client half under
 * `web/src/languages/`. Nothing else in the app changes.
 */

import type { DocumentAdapter } from '../../shared/doc';
import { TypstAdapter } from './typst/adapter';

const adapters: DocumentAdapter[] = [new TypstAdapter()];

/** Adapter responsible for a file path, if any. */
export function adapterForPath(filePath: string): DocumentAdapter | null {
  const lower = filePath.toLowerCase();
  for (const adapter of adapters) {
    if (adapter.extensions.some((extension) => lower.endsWith(extension))) return adapter;
  }
  return null;
}

export function adapterById(id: string): DocumentAdapter | null {
  return adapters.find((adapter) => adapter.id === id) ?? null;
}

export function allAdapters(): DocumentAdapter[] {
  return adapters;
}

/** Language id of a path, falling back to "plain". */
export function languageOf(filePath: string): string {
  return adapterForPath(filePath)?.id ?? 'plain';
}
