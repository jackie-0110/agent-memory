# replicas-memory — Implementation Spec

This is the condensed spec for implementation. The full design rationale is in the design doc the user wrote separately. This file is what you reference when actually writing code.

## What this is

A persistent memory system for parallel coding agents working on a single codebase. Two-tier: ephemeral working memory during sessions, curated main memory after consolidation. Local-first via SQLite for the takehome; designed to migrate to Postgres/Supabase for production deployment with Replicas.

## Scope

**In scope:**
- CLI tool for writing, reading, and searching memory
- SQLite storage with FTS5 keyword search via `better-sqlite3`
- Markdown mirror files for human inspection
- Per-session, per-agent working memory isolation
- LLM-driven consolidation pass via Claude Haiku
- Append-only corrections log
- Demo script showing parallel agents

**Out of scope:**
- Vector embeddings or semantic search
- Web UI
- Multi-machine deployment (mentioned in README only)
- Authentication or access control
- Tests beyond the demo script
- Plugins or alternative storage backends
- Deletion APIs (only soft supersession)
- Async/promise-based code (use synchronous APIs throughout)

## Project setup

### `package.json`

```json
{
  "name": "replicas-memory",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "replicas-memory": "./bin/replicas-memory"
  },
  "scripts": {
    "cli": "tsx src/cli.ts",
    "demo": "tsx demo/demo.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.3.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "demo/**/*"]
}
```

### `bin/replicas-memory`

```bash
#!/usr/bin/env bash
exec npx tsx "$(dirname "$0")/../src/cli.ts" "$@"
```

Make it executable: `chmod +x bin/replicas-memory`.

## Data model

### SQLite schema

```sql
CREATE TABLE memory_main (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                  -- decision|debugging|convention|architecture
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,                           -- comma-separated
  confidence TEXT DEFAULT 'medium',    -- low|medium|high
  created_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  superseded_by INTEGER,
  sources TEXT,                        -- JSON array of {session, agent}
  file_path TEXT NOT NULL,
  FOREIGN KEY (superseded_by) REFERENCES memory_main(id)
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, content, tags,
  content=memory_main,
  content_rowid=id
);

CREATE TRIGGER memory_ai AFTER INSERT ON memory_main BEGIN
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER memory_ad AFTER DELETE ON memory_main BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
END;

CREATE TRIGGER memory_au AFTER UPDATE ON memory_main BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  consolidated_at TEXT
);
```

### TypeScript types (in `src/types.ts`)

```typescript
export type MemoryType = 'decision' | 'debugging' | 'convention' | 'architecture';
export type Confidence = 'low' | 'medium' | 'high';
export type WorkingNoteType = 'observation' | 'decision' | 'debugging' | 'convention' | 'hypothesis' | 'question';

export interface WorkingNote {
  ts: string;
  session_id: string;
  agent_id: string;
  type: WorkingNoteType;
  content: string;
  tags: string[];
  confidence: Confidence;
}

export interface MainEntry {
  id?: number;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  confidence: Confidence;
  created_at: string;
  last_verified: string;
  superseded_by?: number | null;
  sources: Array<{ session: string; agents: string[] }>;
  file_path: string;
}

export interface Session {
  id: string;
  name?: string;
  started_at: string;
  ended_at?: string;
  consolidated_at?: string;
}

export interface ConsolidationAction {
  working_note_index: number;
  action: 'PROMOTE' | 'MERGE' | 'SUPERSEDE' | 'DISCARD';
  target_entry_id: number | null;
  new_entry: Omit<MainEntry, 'id' | 'created_at' | 'last_verified' | 'sources' | 'file_path' | 'superseded_by'> | null;
  rationale: string;
}
```

### Working memory file format

Path: `.memory/working/sess-{id}-agent-{id}.jsonl`

One JSON object per line, matching the `WorkingNote` interface.

### Main memory file format

Path: `.memory/main/{type}/{date}-{slug}.md`

```markdown
---
type: decision
created: 2026-04-11T15:00:00Z
last_verified: 2026-04-11T15:00:00Z
confidence: high
tags: [auth, jwt]
sources:
  - session: sess-abc
    agents: [agent-1, agent-3]
supersedes: 2026-03-15-auth-session.md
---

# Title goes here

Content goes here. Compressed lessons, not transcripts.
```

### Corrections log format

Path: `.memory/corrections.jsonl`, append-only.

```json
{"ts": "...", "session_id": "...", "agent_id": "...", "context": "...", "agent_did": "...", "user_corrected_to": "...", "rationale": "..."}
```

## CLI surface

All commands take optional `--memory-dir` (default: `./.memory/`). Session and agent IDs come from environment variables `REPLICAS_MEMORY_SESSION_ID` and `REPLICAS_MEMORY_AGENT_ID` if not passed explicitly — this is the "agent doesn't have to think about IDs" pattern.

```
replicas-memory init                                                     # create .memory/ structure and DB
replicas-memory session start [name]                                     # create session, print ID
replicas-memory session end <session-id>                                 # mark session ended, trigger consolidation
replicas-memory session list                                             # show recent sessions

replicas-memory note "content" --tags tag1,tag2 [--type observation] [--confidence medium]
replicas-memory search "query" [--limit 5]                               # FTS5 search over main memory
replicas-memory read <file-path-or-id>                                   # print full main memory entry

replicas-memory correct "agent did X" "should be Y" "rationale"          # append to corrections log

replicas-memory consolidate <session-id>                                 # run dreaming pass
replicas-memory status                                                   # show current session, working note count, etc
```

Every command supports `--json` for machine-readable output.

## Module responsibilities

### `src/store.ts`

Pure data layer. No CLI concerns, no LLM calls. Exports:

```typescript
export function initDb(memoryDir: string): Database;
export function writeMainEntry(db: Database, entry: MainEntry): number;
export function readMainEntry(filePath: string): MainEntry;
export function searchMain(db: Database, query: string, limit?: number): Array<{id: number, title: string, snippet: string, file_path: string, last_verified: string, confidence: string}>;
export function appendWorkingNote(memoryDir: string, note: WorkingNote): void;
export function readWorkingNotes(memoryDir: string, sessionId: string): WorkingNote[];
export function createSession(db: Database, name?: string): Session;
export function endSession(db: Database, sessionId: string): void;
export function listSessions(db: Database, limit?: number): Session[];
export function appendCorrection(memoryDir: string, correction: object): void;
```

### `src/cli.ts`

Commander setup. Each command is thin — it parses arguments, calls into `store.ts` or `consolidate.ts`, and formats the output. No business logic in this file.

### `src/consolidate.ts`

The dreaming pass. Exports:

```typescript
export async function consolidateSession(db: Database, memoryDir: string, sessionId: string): Promise<{actionsApplied: number, summary: string}>;
```

Internal functions: `gatherContext`, `buildPrompt`, `callLlm`, `parseActions`, `applyActions`.

### `src/session.ts`

Session lifecycle helpers. Generates session IDs (use `crypto.randomUUID()` and prefix with `sess-`), manages the "current session" concept, etc.

### `src/prompts.ts`

Single export: the consolidation prompt template as a function that takes working notes and main entries and returns a string.

## The consolidation pass

Triggered by `replicas-memory consolidate <session-id>` or automatically by `replicas-memory session end`.

**Steps:**

1. Query SQLite for the session; load all working notes from `.memory/working/sess-{id}-agent-*.jsonl` files.
2. Extract the union of tags from all working notes.
3. Query main memory for entries that share any of those tags. Cap at 30 entries to keep prompt size manageable.
4. Build the consolidation prompt (template in `src/prompts.ts`).
5. Call Claude Haiku via the Anthropic SDK.
6. Parse the JSON response (list of actions).
7. For each action, apply it:
   - `PROMOTE`: insert new row in `memory_main`, write markdown file
   - `MERGE`: append to existing markdown file's content, update `last_verified`, add new sources, update SQLite row
   - `SUPERSEDE`: set `superseded_by` on old row, create new row + file referencing the old
   - `DISCARD`: no-op
8. Move working memory files from `.memory/working/` to `.memory/working/archive/`.
9. Update `sessions` table: set `consolidated_at`.

**Safety properties:**
- Bias toward PROMOTE/MERGE over DISCARD/SUPERSEDE in the prompt
- Never delete working memory files, only archive them
- SUPERSEDE marks old entries but keeps them in the database (filtered from default search results)

## The consolidation prompt

Lives in `src/prompts.ts` as an exported function. Roughly:

```typescript
export function buildConsolidationPrompt(workingNotes: WorkingNote[], mainEntries: MainEntry[]): string {
  return `You are consolidating an agent session's working memory into long-term project memory for a coding agent system.

Working memory from this session (grouped by agent):
${formatWorkingNotes(workingNotes)}

Existing relevant main memory entries (sharing tags with the working notes):
${formatMainEntries(mainEntries)}

Decide what should happen to each working note. Output a JSON array of actions, one per working note. Each action has this schema:

{
  "working_note_index": <int, 0-indexed into the working notes list>,
  "action": "PROMOTE" | "MERGE" | "SUPERSEDE" | "DISCARD",
  "target_entry_id": <int or null, only for MERGE/SUPERSEDE>,
  "new_entry": {
    "type": "decision" | "debugging" | "convention" | "architecture",
    "title": "<5-10 word title>",
    "content": "<5-15 lines, compressed lesson not transcript>",
    "tags": ["tag1", "tag2"],
    "confidence": "low" | "medium" | "high"
  } | null,
  "rationale": "<one sentence explaining why this action>"
}

PRINCIPLES:
1. Be conservative. When in doubt, PROMOTE rather than DISCARD, MERGE rather than SUPERSEDE.
2. Reward convergence. If multiple agents independently observed the same thing, promote with high confidence.
3. Compress. Write lessons, not transcripts.
4. Skip noise. Discard observations that are obvious from the codebase or that are debugging scratch work.
5. Preserve provenance. Don't lose track of which session/agents contributed.

Output ONLY the JSON array, no preamble, no markdown fences.`;
}
```

The exact prompt will need iteration. Get a working version first, then refine with real test data.

## The demo script

Lives in `demo/demo.ts`. Does:

1. Clean up any existing `.memory/` directory.
2. Run `replicas-memory init`.
3. Start a session: `replicas-memory session start parallel-demo`.
4. Spawn 3 child processes via `node:child_process`, each with a different `REPLICAS_MEMORY_AGENT_ID`. Each process runs a small TypeScript function (also in `demo/`) that writes 4-6 working notes about overlapping topics. Use scenarios from `demo/scenarios/` for the note content.
5. Wait for all child processes to finish.
6. Print the working memory state: count of files, sample notes.
7. Run `replicas-memory consolidate <session-id>`.
8. Print the resulting main memory: file tree under `.memory/main/`, show a couple of files.
9. Run a few search queries and print the results.
10. Print a clear "DEMO COMPLETE" message with summary stats.

The demo should run in under 30 seconds total. Output is visually clean with section headers — the user (founder reviewing the takehome) should run it once and immediately understand what the system does.

## Dependencies (locked)

```
@anthropic-ai/sdk      LLM calls
better-sqlite3         SQLite (synchronous)
commander              CLI framework
gray-matter            Markdown frontmatter parsing
```

Dev: `@types/better-sqlite3`, `@types/node`, `tsx`, `typescript`.

That's it. Everything else is in `node:` built-ins (`node:fs`, `node:path`, `node:crypto`, `node:child_process`).

## What success looks like

- `yarn install` followed by `yarn demo` (with `ANTHROPIC_API_KEY` set) runs end-to-end with no errors
- The README explains the system in under 2 minutes of reading
- The README has a clear "production deployment notes" section about Replicas integration
- Every CLI command has helpful `--help` output
- The code is under 1500 lines of TypeScript total (target, not hard limit)
- A reviewer can read the source in 15 minutes and understand the architecture
