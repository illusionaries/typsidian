import type { BlockAction, DocBlock, SourceSplice } from '../../../shared/doc';
import { minimalSplice } from '../../../shared/doc';
import type { LanguageClient } from '../../../shared/doc';
import type { Extension } from '@codemirror/state';

import { plainLanguageClient } from './plain';

/**
 * Language client registry — the light (browser) half of every language plugin.
 *
 * The Typst client lives in `./typst.ts` and is owned by the source-editor
 * surface; this file only maps ids to implementations and provides the
 * fallback used by unknown file types.
 */

const clients = new Map<string, LanguageClient>();

export function registerLanguageClient(client: LanguageClient): void {
  clients.set(client.id, client);
}

export function getLanguageClient(id: string): LanguageClient {
  return clients.get(id) ?? plainLanguageClient;
}

export function knownLanguages(): string[] {
  return [...clients.keys()];
}

/** Convenience: block splices then a plain fallback when a language forgets. */
export function safeSplice(
  client: LanguageClient,
  source: string,
  block: DocBlock,
  text: string,
): SourceSplice {
  try {
    return client.spliceBlockEdit(source, block, text);
  } catch {
    return minimalSplice(source.slice(block.range.from, block.range.to), text, block.range.from);
  }
}

export type { LanguageClient, BlockAction, Extension };
