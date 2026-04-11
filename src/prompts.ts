import type { MainEntry, WorkingNote } from './types.ts';

export function buildConsolidationPrompt(_workingNotes: WorkingNote[], _mainEntries: MainEntry[]): string {
  return [
    'You are consolidating agent working memory into durable shared memory.',
    'Return strict JSON only.',
    'Prompt template pending implementation.',
  ].join('\n');
}
