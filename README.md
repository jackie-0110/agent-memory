# replicas-memory

> Persistent memory for parallel coding agents working on a single fast-moving codebase.

### What this is

Coding agents forget what they learned between sessions and across agents, which leads to redo'ing much of the same work understanding codebases.  `replicas-memory` is a two-tier memory system that captures everything agents observe during a session and uses an LLM pass to distill it into persistent, searchable knowledge. Temporary memory for the VM agents are cheap to write and lossy by design; main memory is curated, shared across agents, and only written by the consolidation pass. 

Note:: **runs locally via SQLite for this takehome.**

## Quickstart

```bash
git clone <repo>
cd replicas-memory
yarn install
export ANTHROPIC_API_KEY=sk-ant-...
yarn demo
```

The demo spawns three agents working in parallel, has them write observations about a shared project, runs the consolidation pass, and verifies a fourth agent can find the consolidated knowledge.



Working memory is the cheap tier. During a session, each agent writes observations, decisions, and debugging notes to its own JSONL file with no coordination overhead. The bar is deliberately low — agents write aggressively because discarding noise is the consolidation pass's job, not the agent's. No two processes ever write the same file, so concurrency is free.

Main memory is the curated tier. It's a collection of markdown files one per persistent insight with YAML frontmatter tracking type, confidence, sources, and supersession history. A SQLite FTS5 index provides millisecond keyword search across all entries. Agents read from main memory but never write to it directly. Only the consolidation pass can promote a working note into main memory, ensuring quality stays high as the project grows.

### How it works

1. **Session start.** `replicas-memory session start <name>` registers a session in SQLite and returns a session ID. Each agent gets its own working memory file derived from session ID + agent ID.

2. **During the session.** Agents call `replicas-memory note "..."` to write observations, tagging them with relevant topics. Each agent writes only to its own JSONL file. Agents write a lot of observations and notes, a lot of noise is expected and handled later.

3. **Session end.** `replicas-memory session end <id>` triggers consolidation automatically. All working notes from the session are gathered and sent to Claude Haiku(gpt-oss-120b since that's all I have access to) for review.

4. **Consolidation.** A single LLM call reviews every working note against existing main memory entries that share overlapping tags. It decides for each note: PROMOTE (new insight → new main entry), MERGE (corroborates existing → update entry), SUPERSEDE (contradicts existing → replace entry), or DISCARD (noise → drop). Working files are archived, not deleted.

5. **Next session.** Future agents call `replicas-memory search "..."` to retrieve consolidated knowledge. Results are ranked by FTS5 relevance. An agent beginning work on authentication will immediately find that "JWT refresh tokens must be rotated on every use" was a hard-won lesson from three sessions ago.

### CLI reference

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



#### Supporting Literature for Approach

- Context retrieval quality dominates model capability for coding agents — SWE-agent showed +10.7pp on SWE-bench from interface improvements alone, without touching the model.
- More memory in context actively hurts performance past ~150–200 instructions — agents need a curated subset, not the full history (SWE-ContextBench, Feb 2026).
- Store decisions and rationale, not descriptions of code — the "what" is always rediscoverable with `rg`; the "why a choice was made" is not.
- The moment of writing is the worst time to decide what's worth keeping — the working/main split separates capture (cheap, during work) from curation (careful, after work).
- Reflective summaries beat raw trajectory replay — the consolidation pass compresses session lessons the same way Reflexion (NeurIPS 2023) showed reflective agents outperform raw trajectory agents.
- Per-writer files solve concurrency for free — Claude Code's JSONL corruption bugs prove that shared append-only files across processes are unsafe; per-agent files eliminate the problem entirely.

#### Architecture

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
