# replicas-memory

> Persistent memory for parallel coding agents working on a single fast-moving codebase.

## What this is

Coding agents forget what they learned. Between sessions, across agents, when context windows fill — observations disappear and work gets redone. `replicas-memory` is a two-tier memory system that captures everything agents observe during a session and uses an LLM pass to distill it into persistent, searchable knowledge. Working notes are cheap to write and lossy by design; main memory is curated, shared across agents, and only written by the consolidation pass. Built for 2–10 parallel agents on a single project, designed for integration with Replicas, runs locally via SQLite for this takehome.

## Quickstart

```bash
git clone <repo>
cd replicas-memory
yarn install
export ANTHROPIC_API_KEY=sk-ant-...
yarn demo
```

The demo spawns three agents working in parallel, has them write observations about a shared project, runs the consolidation pass, and verifies a fourth agent can find the consolidated knowledge.

## Why this exists

- Context retrieval quality dominates model capability for coding agents — SWE-agent showed +10.7pp on SWE-bench from interface improvements alone, without touching the model.
- More memory in context actively hurts performance past ~150–200 instructions — agents need a curated subset, not the full history (SWE-ContextBench, Feb 2026).
- Store decisions and rationale, not descriptions of code — the "what" is always rediscoverable with `rg`; the "why a choice was made" is not.
- The moment of writing is the worst time to decide what's worth keeping — the working/main split separates capture (cheap, during work) from curation (careful, after work).
- Reflective summaries beat raw trajectory replay — the consolidation pass compresses session lessons the same way Reflexion (NeurIPS 2023) showed reflective agents outperform raw trajectory agents.
- Per-writer files solve concurrency for free — Claude Code's JSONL corruption bugs prove that shared append-only files across processes are unsafe; per-agent files eliminate the problem entirely.

## Architecture

```
.memory/
├── working/                          # Per-session, per-agent JSONL files
│   └── sess-{id}-agent-{id}.jsonl
├── main/                             # Curated markdown, indexed by SQLite FTS5
│   ├── decisions/
│   ├── debugging/
│   ├── conventions/
│   └── architecture/
├── corrections.jsonl                 # User overrides, append-only
├── memory.db                         # SQLite + FTS5 index
└── README.md                         # The agent-facing convention doc
```

Working memory is the cheap tier. During a session, each agent writes observations, decisions, and debugging notes to its own JSONL file with no coordination overhead. The bar is deliberately low — agents write aggressively because discarding noise is the consolidation pass's job, not the agent's. No two processes ever write the same file, so concurrency is free.

Main memory is the curated tier. It's a collection of markdown files — one per persistent insight — with YAML frontmatter tracking type, confidence, sources, and supersession history. A SQLite FTS5 index provides millisecond keyword search across all entries. Agents read from main memory but never write to it directly. Only the consolidation pass can promote a working note into main memory, ensuring quality stays high as the project grows.

## How it works

1. **Session start.** `replicas-memory session start <name>` registers a session in SQLite and returns a session ID. Each agent on the team gets its own working memory file derived from session ID + agent ID — no coordination needed.

2. **During the session.** Agents call `replicas-memory note "..."` to write observations, tagging them with relevant topics. Each agent writes only to its own JSONL file. Because the bar is low, agents write liberally — noise is expected and handled downstream.

3. **Session end.** `replicas-memory session end <id>` triggers consolidation automatically. All working notes from the session are gathered and sent to Claude Haiku for review.

4. **Consolidation.** A single LLM call reviews every working note against existing main memory entries that share overlapping tags. It decides for each note: PROMOTE (new insight → new main entry), MERGE (corroborates existing → update entry), SUPERSEDE (contradicts existing → replace entry), or DISCARD (noise → drop). Working files are archived, not deleted.

5. **Next session.** Future agents call `replicas-memory search "..."` to retrieve consolidated knowledge. Results are ranked by FTS5 relevance. An agent beginning work on authentication will immediately find that "JWT refresh tokens must be rotated on every use" was a hard-won lesson from three sessions ago.

## CLI reference

```
replicas-memory init                              # set up .memory/ in the current directory
replicas-memory session start [name]              # start a new session
replicas-memory session end <id>                  # end session and consolidate
replicas-memory note "content" --tags ...         # write a working memory note
replicas-memory search "query"                    # search main memory
replicas-memory read <path>                       # read a main memory entry
replicas-memory correct "..." "..." "..."         # log a user correction
replicas-memory consolidate <id>                  # manually trigger consolidation
```

Session ID and agent ID can be passed via `REPLICAS_MEMORY_SESSION_ID` / `REPLICAS_MEMORY_AGENT_ID` environment variables so agents never have to manage IDs manually. Every command supports `--json` for machine-readable output and `--help` for usage details.

## Design decisions

### What we built
- Two-tier memory (working + main)
- SQLite + FTS5 for search via better-sqlite3 (synchronous, fast, zero infrastructure)
- Markdown mirror for human inspection
- LLM-driven consolidation via Claude Haiku
- Per-agent file isolation for concurrency
- TypeScript with ESM, runnable directly via tsx (no build step)

### What we deliberately skipped
- Vector embeddings (FTS5 keyword search is sufficient for this scale)
- MCP server integration (filesystem IS the API)
- Knowledge graphs (the `supersedes` field handles temporal versioning at 1% the complexity)
- Multi-machine deployment for the takehome (designed for it; production section explains the path)
- Tests (manual demo coverage is sufficient for a one-day build; production version would have them)
- Web UI (cat and rg are the UI)

### Why

Every skipped item maps to a deliberate principle. Vector embeddings were skipped because FTS5 keyword search is sufficient at this scale and avoids the embedding infrastructure tax — if recall gaps appear in production, hybrid retrieval is parked in IDEAS.md. Knowledge graphs were skipped because the `supersedes` field in main memory frontmatter handles the temporal versioning problem at a fraction of the complexity. MCP server integration was skipped because the filesystem already is the API: agents can `cat` any `.memory/main/` file and `rg` across all of them without any protocol overhead. Tests were skipped not from negligence but because the demo provides end-to-end coverage for a one-day build — the production version would add integration tests as the first post-takehome step. A web UI was skipped because `cat` and `rg` are the correct UI for a system whose consumers are agents and developers.

## Production deployment notes

This takehome runs locally because I don't have access to Replicas — but every architectural decision was made with the multi-VM production case in mind. Here's the integration path.

**The Replicas integration story.** When `replicas connect <branch>` provisions a VM, it would also: generate a session ID, inject `REPLICAS_MEMORY_SESSION_ID` and `REPLICAS_MEMORY_AGENT_ID` as environment variables so agents never manage IDs manually, write `.memory/README.md` into the project directory inside the VM so agents understand the memory convention on first boot, and optionally pre-warm context with `replicas-memory search` results based on the branch name. When the VM tears down via `replicas disconnect`, the cleanup hook calls `replicas-memory consolidate <session-id>`. The agent sees a working memory system with zero configuration overhead.

**Storage substrate migration.** SQLite becomes Postgres in Supabase (which Replicas already operates). The schema is nearly identical — `tsvector` replaces FTS5, `gin` indexes replace FTS5 triggers, and row-level security can gate memory to the project. Each VM's agent talks to the shared Supabase instance over the network, so memory is automatically cross-VM with no additional coordination layer. Postgres MVCC handles concurrent writes from multiple VMs trivially. The local `.memory/` directory remains as a debugging mirror inside each VM; Supabase is the source of truth.

**Consolidation triggers.** In production, consolidation runs in three modes: (1) automatically when a VM is torn down via the `replicas disconnect` cleanup hook, (2) after a configurable idle timeout for long-running sessions, and (3) manually via `replicas-memory consolidate <id>` for debugging. Consolidation is single-threaded per project to avoid LLM race conditions — a simple Supabase advisory lock is sufficient.

**The TypeScript codebase drops in cleanly.** Because this is already TypeScript with ESM, it can be added as a workspace package in the existing Replicas monorepo (the `cli/` directory). The CLI command becomes a sub-command of `replicas` — `replicas memory note "..."` instead of `replicas-memory note "..."`. The storage layer swap (SQLite → Supabase Postgres) is a single-file change to `src/store.ts`; all other modules are substrate-agnostic.

**What I'd want to confirm with the team.** Where memory should live in Supabase (same project, separate schema, or separate instance with RLS by project), what the natural session boundary is in the Replicas orchestration model (VM lifecycle vs. explicit session commands), and whether there's a clean teardown hook for triggering consolidation on VM shutdown.

## What I'd build next

- **Production migration to Postgres/Supabase** — the integration plan above is ready to implement; the storage swap is a single-file change to `src/store.ts`.
- **Confidence-weighted retrieval ranking** — boost search results from entries with convergent observations (multiple agents independently noted the same thing), surfacing the most reliable knowledge first.
- **A `verify` command** — runs against the current codebase to detect stale main memory entries, flagging decisions that contradict what's actually in the code.
- **Periodic re-consolidation** — a background pass that re-evaluates older main memory entries against recent sessions, merging or superseding as the project evolves.
- **Cursor extension** — surfaces relevant memory entries inline as the agent opens a file, turning accumulated project knowledge into passive ambient context.

## License

MIT
