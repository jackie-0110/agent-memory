# replicas-memory

This directory is shared memory for coding agents working on this repository.

## What to write

- Write working notes with `replicas-memory note "..." --tags ...` during a session.
- Record decisions, debugging findings, conventions, and architecture insights.
- Prefer facts that would help a future agent move faster.
- Include tags that match the subsystem or concept involved.
- Set confidence honestly. Use `low` for hypotheses and `high` for repeated or verified findings.

## What not to write

- Do not copy large chunks of code into memory.
- Do not restate facts that are trivial to rediscover with `rg`.
- Do not treat scratch thoughts as durable truth.
- Do not write directly into `.memory/main/`.

## Memory model

- `.memory/working/` is cheap, per-session, per-agent, and append-only.
- `.memory/main/` is curated shared memory written by consolidation only.
- Main memory entries are markdown files mirrored from SQLite for human inspection.
- Superseded entries stay in the database for history, but default search hides them.

## Retrieval flow

- Use `replicas-memory search "query"` to find relevant consolidated memory.
- Use `replicas-memory read <path-or-id>` to inspect the full entry before acting on it.
- If memory conflicts with the codebase, trust the codebase and log a correction.

## Corrections

- Use `replicas-memory correct "agent did X" "should be Y" "why"` when a memory-driven action was wrong.
- Corrections are append-only and help future consolidation improve.

## Concurrency

- Each agent writes only to its own working-memory JSONL file.
- Do not edit another agent's working-memory file.
- Consolidation happens after the session and is the only path into shared durable memory.
