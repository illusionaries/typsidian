import type { BlockAction, DocBlock, LanguageClient, SourceSplice } from '../../../shared/doc';
import { blockText, minimalSplice } from '../../../shared/doc';

/** Fallback language: plain text with no syntax awareness. */
export const plainLanguageClient: LanguageClient = {
  id: 'plain',
  modeName: 'Plain text',

  spliceBlockEdit(source: string, block: DocBlock, newText: string): SourceSplice {
    return minimalSplice(blockText(source, block), newText, block.range.from);
  },

  editableText(source: string, block: DocBlock): string {
    return blockText(source, block);
  },

  actions(_source: string, _block: DocBlock): BlockAction[] {
    return [];
  },

  editorExtensions(): unknown[] {
    return [];
  },
};
