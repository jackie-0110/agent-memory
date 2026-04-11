import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  appendWorkingNote,
  createSession,
  endSession,
  initDb,
  listSessions,
  readMainEntry,
  readWorkingNotes,
  searchMain,
  writeMainEntry,
} from './src/store.ts';
import type { MainEntry, WorkingNote } from './src/types.ts';

const memoryDir = join(process.cwd(), '.memory-test');

rmSync(memoryDir, { recursive: true, force: true });

const db = initDb(memoryDir);

const session = createSession(db, 'hour-1-test');
assert.match(session.id, /^sess-/);

const note: WorkingNote = {
  ts: new Date().toISOString(),
  session_id: session.id,
  agent_id: 'agent-1',
  type: 'observation',
  content: 'JWT refresh tokens must be rotated after every successful refresh.',
  tags: ['auth', 'jwt'],
  confidence: 'high',
};

appendWorkingNote(memoryDir, note);

const workingNotes = readWorkingNotes(memoryDir, session.id);
assert.equal(workingNotes.length, 1);
assert.equal(workingNotes[0]?.content, note.content);

const entry: MainEntry = {
  type: 'decision',
  title: 'Rotate JWT refresh tokens',
  content: 'Always issue a new refresh token after a successful refresh request.',
  tags: ['auth', 'jwt'],
  confidence: 'high',
  created_at: new Date().toISOString(),
  last_verified: new Date().toISOString(),
  superseded_by: null,
  sources: [{ session: session.id, agents: ['agent-1'] }],
  file_path: '',
};

const entryId = writeMainEntry(db, entry);
assert.ok(entryId > 0);

const hits = searchMain(db, 'refresh', 5);
assert.equal(hits.length, 1);
assert.equal(hits[0]?.id, entryId);

const filePath = hits[0]?.file_path;
assert.ok(filePath);
assert.ok(existsSync(filePath));

const roundTrip = readMainEntry(filePath);
assert.equal(roundTrip.title, entry.title);
assert.equal(roundTrip.content, entry.content);
assert.deepEqual(roundTrip.tags, entry.tags);

const ended = endSession(db, session.id);
assert.ok(ended.ended_at);

const sessions = listSessions(db);
assert.equal(sessions.length, 1);
assert.equal(sessions[0]?.id, session.id);

db.close();

console.log('test-store.ts passed');
console.log(`memoryDir=${memoryDir}`);
console.log(`sessionId=${session.id}`);
console.log(`entryId=${entryId}`);
