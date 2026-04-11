# replicas-memory

> Persistent memory for parallel coding agents working on a single fast-moving codebase.

<!--
README skeleton — fill this in during Hour 7. Sections marked TODO are to be written then.
The structure is fixed; the content is yours to write.
-->

## What this is

TODO: One paragraph. Explain the project to someone who has never heard of it. Lead with the problem ("coding agents forget what they learned across sessions"), then the solution ("a two-tier memory system that captures observations cheaply and consolidates them between sessions"), then the scope ("built for 2-10 parallel agents on a single project — designed for integration with Replicas, runs locally for this takehome").

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

TODO: 5-6 bullets covering the foundational insights:
- Context retrieval quality dominates model capability for coding agents (SWE-agent showed +10.7pp on SWE-bench from interface improvements alone)
- More memory in context actively hurts performance past ~150-200 instructions (SWE-ContextBench, Feb 2026)
- Store decisions and rationale, not descriptions of code (the "what" is rediscoverable with `rg`)
- The moment of writing is the worst moment to decide what's worth keeping (motivates the working/main split)
- Reflective summaries beat raw trajectory replay (Reflexion, NeurIPS 2023)
- Per-writer files solve concurrency for free (Claude Code's JSONL corruption bugs prove the alternative is unsafe)

Each bullet should be one sentence.

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

TODO: Two paragraphs explaining the two-tier model. First paragraph: working memory is cheap, lossy, per-agent — agents write aggressively during sessions because the bar is low. Second paragraph: main memory is curated, persistent, shared — only written by the consolidation pass, never by agents directly. Explain why the split solves concurrency, curation quality, drift, and debuggability simultaneously.

## How it works

TODO: Walk through the lifecycle:

1. **Session start.** `replicas-memory session start <name>` creates a session ID. Each agent gets its own working memory file derived from session ID + agent ID.
2. **During the session.** Agents call `replicas-memory note "..."` to write observations. Each agent writes only to its own file. No coordination needed.
3. **Session end.** `replicas-memory session end <id>` triggers the consolidation pass.
4. **Consolidation.** A single LLM call (Claude Haiku) reviews all working notes, fetches relevant existing main memory by tag overlap, and decides what to promote, merge, supersede, or discard.
5. **Next session.** Future agents call `replicas-memory search "..."` to find consolidated knowledge from prior sessions.

Each step in 2-3 sentences. Don't over-explain.

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

## Design decisions

TODO: What we built, what we deliberately skipped, and why. Three subsections:

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
TODO: Reference the foundational insights. Connect each "skipped" item to a specific insight that justifies skipping it.

## Production deployment notes

TODO: This is the most important section in the README. The takehome runs locally, but the founder needs to see that I understood how it would work in their actual environment.

Cover:

1. **Why local-first for the takehome.** I didn't have access to Replicas, so the takehome runs on a single machine via SQLite. The architecture is designed for the multi-VM case from the ground up — every architectural decision considers what changes when memory becomes shared across VMs.

2. **The Replicas integration story.** When `replicas connect <branch>` provisions a VM, it would also: generate a session ID, write `.memory/README.md` into the project directory inside the VM, set `REPLICAS_MEMORY_SESSION_ID` and `REPLICAS_MEMORY_AGENT_ID` environment variables so the agent's tool calls don't need to pass them explicitly, and optionally pre-warm Cursor's context with `replicas-memory search` results based on the branch name.

3. **Storage substrate migration.** SQLite becomes Postgres in Supabase (which Replicas already operates). The schema is nearly identical — `tsvector` replaces FTS5, `gin` indexes replace FTS5 triggers, everything else is the same. Each VM's agent talks to the shared Supabase instance over the network, so memory is automatically cross-VM with no additional coordination layer. Postgres MVCC handles concurrent writes from multiple VMs trivially.

4. **The local `.memory/` directory becomes optional.** In production, it exists only as a debugging mirror inside each VM. Supabase is the source of truth. Users who want to inspect what an agent remembered can either query Supabase directly or `cat` the local mirror inside the VM.

5. **Consolidation triggers.** In production, consolidation runs when a VM is torn down (cleanup hook in `replicas disconnect`) or after a configurable idle timeout for long-running sessions. Consolidation is single-threaded per project to avoid race conditions.

6. **The TypeScript codebase drops in cleanly.** Because the takehome is already TypeScript with ESM, it can be added as a workspace package in the existing Replicas monorepo (the `cli/` directory). The CLI command becomes a sub-command of `replicas` (e.g., `replicas memory note "..."` instead of `replicas-memory note "..."`).

7. **What I'd want to confirm with the team before implementing this.** Where in Supabase memory should live (same project, separate schema, separate instance), what the natural session boundary is in the Replicas orchestration model, and whether there's a clean teardown hook for triggering consolidation.

This section should be 5-6 paragraphs. It's the section that proves I thought about the real product, not just the toy version.

## What I'd build next

TODO: 4-5 bullets pointing at things in IDEAS.md. Each should be one sentence explaining the value.

- Production migration to Postgres/Supabase (the integration plan above)
- Confidence-weighted retrieval ranking (boost search results from convergent observations)
- A `verify` command that runs against the current codebase to detect stale entries
- Periodic re-consolidation pass that re-evaluates old entries against recent ones
- Cursor extension that surfaces relevant memory entries inline as completion hints

## License

MIT
