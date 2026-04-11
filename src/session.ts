import Database from 'better-sqlite3';

import type { Session } from './types.ts';

export interface SessionContext {
  session: Session;
  memoryDir: string;
}

export function resolveSessionContext(
  _db: Database.Database,
  _memoryDir: string,
  _sessionId?: string,
): SessionContext {
  throw new Error('Not implemented yet.');
}
