import Database from 'better-sqlite3';
import matter from 'gray-matter';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { MainEntry, SearchResult, Session, WorkingNote } from './types.ts';

const MAIN_DIRS = {
  decision: 'decisions',
  debugging: 'debugging',
  convention: 'conventions',
  architecture: 'architecture',
} as const;

const AGENT_CONVENTION_DOC = `# replicas-memory

This directory is shared memory for coding agents working on this repository.

## What to write

- Write working notes with \`replicas-memory note "..." --tags ...\` during a session.
- Record decisions, debugging findings, conventions, and architecture insights.
- Prefer facts that would help a future agent move faster.
- Include tags that match the subsystem or concept involved.
- Set confidence honestly. Use \`low\` for hypotheses and \`high\` for repeated or verified findings.

## What not to write

- Do not copy large chunks of code into memory.
- Do not restate facts that are trivial to rediscover with \`rg\`.
- Do not treat scratch thoughts as durable truth.
- Do not write directly into \`.memory/main/\`.

## Memory model

- \`.memory/working/\` is cheap, per-session, per-agent, and append-only.
- \`.memory/main/\` is curated shared memory written by consolidation only.
- Main memory entries are markdown files mirrored from SQLite for human inspection.
- Superseded entries stay in the database for history, but default search hides them.

## Retrieval flow

- Use \`replicas-memory search "query"\` to find relevant consolidated memory.
- Use \`replicas-memory read <path-or-id>\` to inspect the full entry before acting on it.
- If memory conflicts with the codebase, trust the codebase and log a correction.

## Corrections

- Use \`replicas-memory correct "agent did X" "should be Y" "why"\` when a memory-driven action was wrong.
- Corrections are append-only and help future consolidation improve.

## Concurrency

- Each agent writes only to its own working-memory JSONL file.
- Do not edit another agent's working-memory file.
- Consolidation happens after the session and is the only path into shared durable memory.
`;

function ensureMemoryLayout(memoryDir: string): void {
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(memoryDir, 'working'), { recursive: true });
  mkdirSync(join(memoryDir, 'working', 'archive'), { recursive: true });
  mkdirSync(join(memoryDir, 'main'), { recursive: true });

  for (const directory of Object.values(MAIN_DIRS)) {
    mkdirSync(join(memoryDir, 'main', directory), { recursive: true });
  }

  const correctionsPath = join(memoryDir, 'corrections.jsonl');
  if (!existsSync(correctionsPath)) {
    writeFileSync(correctionsPath, '', 'utf8');
  }

  writeFileSync(join(memoryDir, 'README.md'), AGENT_CONVENTION_DOC, 'utf8');
}

function slugify(value: string): string {
  const ascii = value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return ascii || 'memory-entry';
}

function buildMarkdown(entry: MainEntry): string {
  const frontmatter = {
    type: entry.type,
    created: entry.created_at,
    last_verified: entry.last_verified,
    confidence: entry.confidence,
    tags: entry.tags,
    sources: entry.sources,
    superseded_by: entry.superseded_by ?? null,
  };

  const content = `# ${entry.title.trim()}\n\n${entry.content.trim()}\n`;
  return matter.stringify(content, frontmatter);
}

function parseMarkdownContent(rawContent: string): { title: string; content: string } {
  const trimmed = rawContent.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0]?.trim() ?? '';

  if (firstLine.startsWith('# ')) {
    return {
      title: firstLine.slice(2).trim(),
      content: lines.slice(1).join('\n').trim(),
    };
  }

  return {
    title: 'Untitled Memory',
    content: trimmed,
  };
}

function getDbPath(memoryDir: string): string {
  return join(memoryDir, 'memory.db');
}

function getMemoryDirFromDb(db: Database.Database): string {
  return resolve(getDbPathFromDatabase(db), '..');
}

function getDbPathFromDatabase(db: Database.Database): string {
  const row = db.prepare('PRAGMA database_list').all() as Array<{ file: string }>;
  const mainDb = row.find((entry) => entry.file);

  if (!mainDb?.file) {
    throw new Error('Unable to resolve SQLite database path.');
  }

  return mainDb.file;
}

function buildEntryFilePath(memoryDir: string, entry: MainEntry): string {
  const folder = MAIN_DIRS[entry.type];
  const datePrefix = entry.created_at.slice(0, 10);
  const baseName = `${datePrefix}-${slugify(entry.title)}`;
  let filePath = join(memoryDir, 'main', folder, `${baseName}.md`);
  let counter = 1;

  while (existsSync(filePath)) {
    filePath = join(memoryDir, 'main', folder, `${baseName}-${counter}.md`);
    counter += 1;
  }

  return filePath;
}

function parseSources(rawSources: string | null): MainEntry['sources'] {
  if (!rawSources) {
    return [];
  }

  const parsed = JSON.parse(rawSources) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const session = 'session' in item ? item.session : undefined;
    const agents = 'agents' in item ? item.agents : undefined;

    if (typeof session !== 'string' || !Array.isArray(agents)) {
      return [];
    }

    return [
      {
        session,
        agents: agents.map((agent) => String(agent)),
      },
    ];
  });
}

function normalizeMainEntryRow(row: {
  id: number;
  type: string;
  title: string;
  content: string;
  tags: string | null;
  confidence: string;
  created_at: string;
  last_verified: string;
  superseded_by: number | null;
  sources: string | null;
  file_path: string;
}): MainEntry {
  return {
    id: row.id,
    type: row.type as MainEntry['type'],
    title: row.title,
    content: row.content,
    tags: row.tags ? row.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
    confidence: row.confidence as MainEntry['confidence'],
    created_at: row.created_at,
    last_verified: row.last_verified,
    superseded_by: row.superseded_by,
    sources: parseSources(row.sources),
    file_path: row.file_path,
  };
}

function readSessionRow(db: Database.Database, sessionId: string): Session {
  const row = db
    .prepare(
      `SELECT id, name, started_at, ended_at, consolidated_at
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        id: string;
        name: string | null;
        started_at: string;
        ended_at: string | null;
        consolidated_at: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`Session ${sessionId} not found.`);
  }

  return {
    id: row.id,
    name: row.name ?? undefined,
    started_at: row.started_at,
    ended_at: row.ended_at ?? undefined,
    consolidated_at: row.consolidated_at ?? undefined,
  };
}

function normalizeSessionRow(row: {
  id: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  consolidated_at: string | null;
}): Session {
  return {
    id: row.id,
    name: row.name ?? undefined,
    started_at: row.started_at,
    ended_at: row.ended_at ?? undefined,
    consolidated_at: row.consolidated_at ?? undefined,
  };
}

export function initDb(memoryDir: string): Database.Database {
  ensureMemoryLayout(memoryDir);

  const db = new Database(getDbPath(memoryDir));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_main (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      confidence TEXT DEFAULT 'medium',
      created_at TEXT NOT NULL,
      last_verified TEXT NOT NULL,
      superseded_by INTEGER,
      sources TEXT,
      file_path TEXT NOT NULL,
      FOREIGN KEY (superseded_by) REFERENCES memory_main(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title, content, tags,
      content=memory_main,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_main BEGIN
      INSERT INTO memory_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_main BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_main BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
      VALUES('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO memory_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      consolidated_at TEXT
    );
  `);

  return db;
}

export function writeMainEntry(db: Database.Database, entry: MainEntry): number {
  const memoryDir = getMemoryDirFromDb(db);
  const filePath = entry.file_path || buildEntryFilePath(memoryDir, entry);
  const serializedSources = JSON.stringify(entry.sources);

  const result = db
    .prepare(
      `INSERT INTO memory_main (
        type, title, content, tags, confidence, created_at, last_verified, superseded_by, sources, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.type,
      entry.title,
      entry.content,
      entry.tags.join(','),
      entry.confidence,
      entry.created_at,
      entry.last_verified,
      entry.superseded_by ?? null,
      serializedSources,
      filePath,
    );

  const id = Number(result.lastInsertRowid);
  const entryWithPath: MainEntry = { ...entry, id, file_path: filePath };
  writeFileSync(filePath, buildMarkdown(entryWithPath), 'utf8');

  return id;
}

export function readMainEntry(filePath: string): MainEntry {
  const parsed = matter(readFileSync(filePath, 'utf8'));
  const { title, content } = parseMarkdownContent(parsed.content);
  const data = parsed.data as Record<string, unknown>;

  return {
    type: String(data.type) as MainEntry['type'],
    title: typeof data.title === 'string' ? data.title : title,
    content,
    tags: Array.isArray(data.tags) ? data.tags.map((tag) => String(tag)) : [],
    confidence: String(data.confidence) as MainEntry['confidence'],
    created_at: String(data.created),
    last_verified: String(data.last_verified),
    superseded_by:
      typeof data.superseded_by === 'number' ? data.superseded_by : data.superseded_by === null ? null : undefined,
    sources: Array.isArray(data.sources) ? (data.sources as MainEntry['sources']) : [],
    file_path: filePath,
  };
}

export function getMainEntry(db: Database.Database, id: number): MainEntry {
  const row = db
    .prepare(
      `SELECT id, type, title, content, tags, confidence, created_at, last_verified, superseded_by, sources, file_path
       FROM memory_main
       WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        type: string;
        title: string;
        content: string;
        tags: string | null;
        confidence: string;
        created_at: string;
        last_verified: string;
        superseded_by: number | null;
        sources: string | null;
        file_path: string;
      }
    | undefined;

  if (!row) {
    throw new Error(`Main memory entry ${id} not found.`);
  }

  return normalizeMainEntryRow(row);
}

export function listMainEntriesByTags(db: Database.Database, tags: string[], limit = 30): MainEntry[] {
  const uniqueTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];

  if (uniqueTags.length === 0) {
    return [];
  }

  const whereClause = uniqueTags.map(() => "((',' || COALESCE(tags, '') || ',') LIKE ?)").join(' OR ');
  const rows = db
    .prepare(
      `SELECT id, type, title, content, tags, confidence, created_at, last_verified, superseded_by, sources, file_path
       FROM memory_main
       WHERE superseded_by IS NULL AND (${whereClause})
       ORDER BY last_verified DESC
       LIMIT ?`,
    )
    .all(...uniqueTags.map((tag) => `%,${tag},%`), limit) as Array<{
    id: number;
    type: string;
    title: string;
    content: string;
    tags: string | null;
    confidence: string;
    created_at: string;
    last_verified: string;
    superseded_by: number | null;
    sources: string | null;
    file_path: string;
  }>;

  return rows.map(normalizeMainEntryRow);
}

export function updateMainEntry(db: Database.Database, entry: MainEntry & { id: number }): void {
  db.prepare(
    `UPDATE memory_main
     SET type = ?, title = ?, content = ?, tags = ?, confidence = ?, created_at = ?, last_verified = ?, superseded_by = ?, sources = ?, file_path = ?
     WHERE id = ?`,
  ).run(
    entry.type,
    entry.title,
    entry.content,
    entry.tags.join(','),
    entry.confidence,
    entry.created_at,
    entry.last_verified,
    entry.superseded_by ?? null,
    JSON.stringify(entry.sources),
    entry.file_path,
    entry.id,
  );

  writeFileSync(entry.file_path, buildMarkdown(entry), 'utf8');
}

export function searchMain(db: Database.Database, query: string, limit = 5): SearchResult[] {
  return db
    .prepare(
      `SELECT
        memory_main.id AS id,
        memory_main.title AS title,
        snippet(memory_fts, 1, '[', ']', '...', 12) AS snippet,
        memory_main.file_path AS file_path,
        memory_main.last_verified AS last_verified,
        memory_main.confidence AS confidence
      FROM memory_fts
      JOIN memory_main ON memory_main.id = memory_fts.rowid
      WHERE memory_fts MATCH ? AND memory_main.superseded_by IS NULL
      ORDER BY bm25(memory_fts)
      LIMIT ?`,
    )
    .all(query, limit) as SearchResult[];
}

export function appendWorkingNote(memoryDir: string, note: WorkingNote): void {
  ensureMemoryLayout(memoryDir);
  const filePath = join(memoryDir, 'working', `${note.session_id}-agent-${note.agent_id}.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(note)}\n`, 'utf8');
}

export function readWorkingNotes(memoryDir: string, sessionId: string): WorkingNote[] {
  const workingDir = join(memoryDir, 'working');
  if (!existsSync(workingDir)) {
    return [];
  }

  const prefix = `${sessionId}-agent-`;
  return readdirSync(workingDir)
    .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith('.jsonl'))
    .sort()
    .flatMap((fileName) => {
      const raw = readFileSync(join(workingDir, fileName), 'utf8').trim();
      if (!raw) {
        return [];
      }

      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkingNote);
    });
}

export function archiveWorkingNotes(memoryDir: string, sessionId: string): number {
  const workingDir = join(memoryDir, 'working');
  const archiveDir = join(memoryDir, 'working', 'archive');

  if (!existsSync(workingDir)) {
    return 0;
  }

  const prefix = `${sessionId}-agent-`;
  const matchingFiles = readdirSync(workingDir)
    .filter(
    (fileName) => fileName.startsWith(prefix) && fileName.endsWith('.jsonl'),
    )
    .sort();

  for (const fileName of matchingFiles) {
    renameSync(join(workingDir, fileName), join(archiveDir, fileName));
  }

  return matchingFiles.length;
}

export function createSession(db: Database.Database, name?: string): Session {
  const session: Session = {
    id: `sess-${randomUUID()}`,
    name,
    started_at: new Date().toISOString(),
  };

  db.prepare('INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)').run(
    session.id,
    session.name ?? null,
    session.started_at,
  );

  return session;
}

export function endSession(db: Database.Database, sessionId: string): Session {
  const endedAt = new Date().toISOString();
  const result = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);

  if (result.changes === 0) {
    throw new Error(`Session ${sessionId} not found.`);
  }

  return readSessionRow(db, sessionId);
}

export function markSessionConsolidated(db: Database.Database, sessionId: string, consolidatedAt = new Date().toISOString()): Session {
  const result = db.prepare('UPDATE sessions SET consolidated_at = ? WHERE id = ?').run(consolidatedAt, sessionId);

  if (result.changes === 0) {
    throw new Error(`Session ${sessionId} not found.`);
  }

  return readSessionRow(db, sessionId);
}

export function listSessions(db: Database.Database): Session[] {
  const rows = db
    .prepare(
      `SELECT id, name, started_at, ended_at, consolidated_at
       FROM sessions
       ORDER BY started_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string | null;
    started_at: string;
    ended_at: string | null;
    consolidated_at: string | null;
  }>;

  return rows.map(normalizeSessionRow);
}

export function getSession(db: Database.Database, sessionId: string): Session {
  return readSessionRow(db, sessionId);
}

export function getMainEntryFilePath(db: Database.Database, id: number): string {
  const row = db.prepare('SELECT file_path FROM memory_main WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined;

  if (!row) {
    throw new Error(`Main memory entry ${id} not found.`);
  }

  return row.file_path;
}

export function appendCorrection(
  memoryDir: string,
  correction: {
    session_id?: string;
    agent_id?: string;
    context?: string;
    agent_did: string;
    user_corrected_to: string;
    rationale: string;
  },
): void {
  ensureMemoryLayout(memoryDir);
  appendFileSync(
    join(memoryDir, 'corrections.jsonl'),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      ...correction,
    })}\n`,
    'utf8',
  );
}
