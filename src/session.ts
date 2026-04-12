import Database from 'better-sqlite3';

import { getSession } from './store.ts';
import type { Session } from './types.ts';

export interface SessionContext {
  session: Session;
  memoryDir: string;
}

export function resolveSessionContext(
  db: Database.Database,
  memoryDir: string,
  sessionId?: string,
): SessionContext {
  const resolvedSessionId = sessionId ?? process.env.REPLICAS_MEMORY_SESSION_ID;

  if (!resolvedSessionId) {
    throw new Error(
      'No session ID provided. Pass one explicitly or set REPLICAS_MEMORY_SESSION_ID in the environment.',
    );
  }

  return {
    session: getSession(db, resolvedSessionId),
    memoryDir,
  };
}
