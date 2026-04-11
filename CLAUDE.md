# replicas-memory — Working with Claude Code

This file is read on every turn. It defines how you (Claude) should work in this repository. Read it carefully and follow it.

## What we are building

A persistent memory system for coding agents running in parallel, called **replicas-memory**. It's a one-day takehome project for a YC company called Replicas that runs sandboxed Ubuntu VMs for coding agents (think Cursor + remote SSH on disposable VMs spawned by a `replicas connect <branch>` CLI command).

The takehome runs locally on a single machine because the candidate doesn't have access to Replicas itself. The architecture is designed so that the production version slots into Replicas' existing infrastructure (TypeScript CLI, Supabase backend) with minimal changes — see the README's "Production deployment notes" section for the integration plan.

The full design rationale lives in `SPEC.md`. The hour-by-hour plan lives in `PLAN.md`. Read both before writing any code. Update `PLAN.md` as you complete steps.

## The build constraints

- **One day total.** Every hour matters. If you find yourself going down a rabbit hole, surface it instead of grinding through it.
- **Local-first.** Runs on a single machine via SQLite. No network services, no Docker, no cloud dependencies. The user clones the repo and runs one command.
- **TypeScript with ESM.** This matches Replicas' actual stack (Node, Yarn, TypeScript). The signal to the founder matters.
- **Demo must work end-to-end before polish.** A working ugly demo beats a polished half-feature.
- **The README and demo script are worth as much as the code.** Don't deprioritize them.

## The locked stack

These are decided. Do not deviate without asking the user first.

- **Language:** TypeScript with ESM (`"type": "module"` in package.json)
- **Runtime:** Node.js 20+, executed via `tsx` (no compile step, run `.ts` files directly)
- **CLI framework:** `commander`
- **Database:** SQLite via `better-sqlite3` (synchronous API, has FTS5 built in)
- **Markdown frontmatter:** `gray-matter`
- **LLM:** Anthropic Claude Haiku via `@anthropic-ai/sdk`
- **Package manager:** `yarn` (matches Replicas)

That is the complete dependency list. Do not add anything else without asking.

## The rules of engagement

### Things you should do

- Read `SPEC.md` and `PLAN.md` at the start of every working session. They are the source of truth for what to build.
- After completing a step in `PLAN.md`, update its checkbox to `[x]` and briefly note any deviation from the plan.
- Use `node:` prefixes for built-in imports (`import { readFileSync } from 'node:fs'`).
- Use synchronous APIs from `better-sqlite3` and `node:fs`. This is a CLI; there's no event loop work happening in parallel that needs async.
- Write small, testable functions. Prefer 20 lines over 100.
- Use TypeScript types throughout. Don't use `any`. Use `unknown` and narrow when you have to deal with untyped data.
- When you finish a feature, write a one-line manual test command in your response so the user can verify it works.
- Keep error messages user-facing and helpful. "Session sess-abc not found. Did you mean sess-abd?" beats "Error: undefined".

### Things you should NOT do

- **Do not add dependencies without asking.** The locked list above is complete. Anything else, ask first.
- **Do not write tests for the takehome.** This is controversial advice but correct for a one-day build. Manual testing via the demo script is sufficient. Spend the time on features and the README instead. If the user explicitly asks for tests, then write them.
- **Do not set up ESLint or Prettier.** Tooling rabbit hole. Use whatever the editor does by default.
- **Do not configure a build step or `dist/` output.** Use `tsx` to run TypeScript directly. The `bin` field in package.json points at a shell script that calls `tsx`.
- **Do not over-engineer the consolidation prompt on the first pass.** Get a working version with a basic prompt, then iterate with real data. Premature prompt engineering wastes hours.
- **Do not build features not in `SPEC.md` or `PLAN.md`.** If you think of something that would be cool, write it in `IDEAS.md` and keep moving.
- **Do not refactor working code unless asked.** A messy function that works is better than a clean function that doesn't ship.
- **Do not use vector embeddings, semantic search libraries, MCP servers, or any LLM frameworks (LangChain, LlamaIndex, etc.).** SQLite FTS5 is the search layer. The Anthropic SDK is the only LLM dependency. This is a hard constraint from the design — see `SPEC.md` §11.
- **Do not write a web UI or any frontend.** CLI only.
- **Do not abstract for "future flexibility."** Hard-code SQLite. Hard-code markdown. Hard-code the Anthropic API. Pluggability is the enemy of shipping.
- **Do not use callback-style or promise-wrapped sync code.** `better-sqlite3` is synchronous on purpose. Embrace it.

### When you're unsure

If a decision isn't covered by `SPEC.md` or `PLAN.md`, **ask the user before guessing**. The user has context on the founder's preferences and the takehome's evaluation criteria that you don't have. A 10-second clarification beats 30 minutes of rework.

For implementation details that are clearly internal (variable names, file organization within a module, exact SQL syntax), make a reasonable choice and move on without asking.

## The architecture in one paragraph

Two-tier memory: **working memory** (per-session, per-agent JSONL files, cheap to write, lossy by design) and **main memory** (curated markdown files with frontmatter, indexed by SQLite FTS5, only written by the consolidation pass). Agents call three commands during a session: `replicas-memory note "..."` to write, `replicas-memory search "..."` to query, `replicas-memory read <path>` to fetch full content. When a session ends, `replicas-memory consolidate <session-id>` runs an LLM pass that promotes/merges/supersedes/discards working notes into main memory. Concurrency is handled by per-agent file isolation (no two processes ever write the same file). The full design rationale is in `SPEC.md`.

## The directory layout you should create

```
replicas-memory/
├── CLAUDE.md              # this file
├── SPEC.md                # design spec (already exists)
├── PLAN.md                # build plan (already exists)
├── README.md              # user-facing readme (skeleton exists, you fill in)
├── IDEAS.md               # park future ideas here, do not implement
├── package.json           # ESM, type: module, bin: replicas-memory
├── tsconfig.json          # ESM-friendly config, no emit
├── bin/
│   └── replicas-memory    # shell script that calls tsx src/cli.ts "$@"
├── src/
│   ├── cli.ts             # commander commands, the user-facing surface
│   ├── store.ts           # SQLite + markdown read/write
│   ├── consolidate.ts     # the dreaming pass
│   ├── session.ts         # session start/end lifecycle
│   ├── prompts.ts         # the consolidation prompt template
│   └── types.ts           # shared TypeScript types
├── demo/
│   ├── demo.ts            # spawns 3 agent processes, runs end-to-end
│   └── scenarios/         # hand-crafted working notes for testing
│       ├── auth-session.jsonl
│       └── debugging-session.jsonl
└── .memory/               # created at runtime, gitignored
    ├── working/
    ├── main/
    │   ├── decisions/
    │   ├── debugging/
    │   ├── conventions/
    │   └── architecture/
    ├── corrections.jsonl
    ├── memory.db
    └── README.md          # the agent-facing convention doc
```

## How to interact with the user

- The user is building this as a takehome. They are stressed about time. Be efficient with their attention.
- Default to action: when they ask for something, do it and report back, don't ask three clarifying questions first.
- When you finish a chunk, give them the manual test command to verify it works, then wait for confirmation before moving to the next chunk.
- If you hit a real blocker (missing API key, ambiguous spec, dependency issue), surface it immediately and clearly. Don't bury it at the end of a long response.
- Keep your responses focused. A one-paragraph status update beats a five-paragraph essay.

## What success looks like at the end of the day

1. A user clones the repo, runs `yarn install`, sets `ANTHROPIC_API_KEY`, runs `yarn demo`, and sees three agents write notes, consolidate them, and a fourth agent successfully search and find the result.
2. The README explains the project in under two minutes of reading.
3. The "production deployment notes" section in the README explains the multi-VM Replicas integration story clearly.
4. Every CLI command has clear `--help` output.
5. The code is small, readable, and obviously TypeScript-native (uses types properly, uses ESM imports, uses `better-sqlite3` synchronously).

If we hit all five, the takehome is successful. Optimize for these, not for anything else.
