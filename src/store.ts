import type Database from 'better-sqlite3';

import type { MainEntry, SearchResult, Session, WorkingNote } from './types.ts';

export function initDb(_memoryDir: string): Database {
  throw new Error('Not implemented yet.');
}

export function writeMainEntry(_db: Database, _entry: MainEntry): number {
  throw new Error('Not implemented yet.');
}

export function readMainEntry(_filePath: string): MainEntry {
  throw new Error('Not implemented yet.');
}

export function searchMain(_db: Database, _query: string, _limit = 5): SearchResult[] {
  throw new Error('Not implemented yet.');
}

export function appendWorkingNote(_memoryDir: string, _note: WorkingNote): void {
  throw new Error('Not implemented yet.');
}

export function readWorkingNotes(_memoryDir: string, _sessionId: string): WorkingNote[] {
  throw new Error('Not implemented yet.');
}

export function createSession(_db: Database, _name?: string): Session {
  throw new Error('Not implemented yet.');
}

export function endSession(_db: Database, _sessionId: string): Session {
  throw new Error('Not implemented yet.');
}

export function listSessions(_db: Database): Session[] {
  throw new Error('Not implemented yet.');
}
