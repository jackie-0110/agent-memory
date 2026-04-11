import Database from 'better-sqlite3';

import type { ConsolidationAction, MainEntry, WorkingNote } from './types.ts';

export interface ConsolidationContext {
  workingNotes: WorkingNote[];
  relatedEntries: MainEntry[];
}

export function gatherContext(
  _db: Database.Database,
  _memoryDir: string,
  _sessionId: string,
): ConsolidationContext {
  throw new Error('Not implemented yet.');
}

export function parseActions(_responseText: string): ConsolidationAction[] {
  throw new Error('Not implemented yet.');
}

export function applyActions(
  _db: Database.Database,
  _memoryDir: string,
  _sessionId: string,
  _actions: ConsolidationAction[],
): void {
  throw new Error('Not implemented yet.');
}

export function consolidateSession(_db: Database.Database, _memoryDir: string, _sessionId: string): void {
  throw new Error('Not implemented yet.');
}
