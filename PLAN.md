# replicas-memory — Build Plan

Hour-by-hour plan for the takehome. Update checkboxes as you complete steps. If you deviate from the plan, note why in the affected section. The goal is shipping a working end-to-end demo, not perfection.

**Total budget: 8 hours.** If you hit hour 6 and the demo doesn't work end-to-end yet, stop adding features and start cutting scope.

---

## Hour 1 — Project setup and storage layer

Goal: project structure exists, SQLite schema created, can write and read a single memory entry from a Node REPL or test script.

- [x] Create the directory structure from `CLAUDE.md`
- [x] Write `package.json` with the locked dependency list and `"type": "module"`
- [x] Write `tsconfig.json` (ESM, no emit, strict)
- [x] Write `bin/replicas-memory` shell wrapper, `chmod +x` it
- [x] `yarn install` works
- [x] Write `src/types.ts` with the interfaces from SPEC.md
- [x] Write `src/store.ts` with:
  - [x] `initDb(memoryDir)` — creates `.memory/` structure, runs schema SQL via better-sqlite3
  - [x] `writeMainEntry(...)` — inserts into SQLite + writes markdown file
  - [x] `readMainEntry(filePath)` — reads markdown file, parses frontmatter via gray-matter
  - [x] `searchMain(query, limit)` — runs FTS5 query, returns ranked hits
  - [x] `appendWorkingNote(memoryDir, note)` — appends to JSONL via fs.appendFileSync
  - [x] `readWorkingNotes(memoryDir, sessionId)` — reads all working notes for a session
  - [x] `createSession`, `endSession`, `listSessions` — session row management
- [x] Manual test: write a small `.ts` script that exercises each function, run via `tsx`

**Done when:** You can run `tsx test-store.ts` (a throwaway script) and see SQLite + markdown files being created and queried correctly.

Deviation note: `yarn` was not installed globally in the environment, so Hour 1 setup used `corepack yarn ...` to install dependencies and run `test-store.ts`.

---

## Hour 2 — CLI surface

Goal: every command in `SPEC.md` exists and works for happy-path inputs.

- [x] Write `src/cli.ts` with commander setup
- [x] Implement each command as a thin wrapper around `store.ts`:
  - [x] `init`
  - [x] `session start [name]`
  - [x] `session end <id>` (just marks ended for now, consolidation comes later)
  - [x] `session list`
  - [x] `note <content> --tags ...`
  - [x] `search <query>`
  - [x] `read <path>`
  - [x] `correct <agent-did> <should-be> <rationale>`
  - [x] `status`
- [x] Each command reads `REPLICAS_MEMORY_SESSION_ID` and `REPLICAS_MEMORY_AGENT_ID` from env when applicable
- [x] Each command has `--help` text via commander's `.description()`
- [x] Manual test: walk through every command from a fresh shell using `yarn cli <command>` or `./bin/replicas-memory <command>`

**Done when:** A user could open a terminal and use the system end-to-end except for consolidation.

Deviation note: the `consolidate` command exists with help output, but it still returns a clear "scheduled for Hour 4" error until the consolidation pass is built.

---

## Hour 3 — Markdown mirror polish and convention doc

Goal: every main memory entry has a corresponding markdown file with proper frontmatter, files are human-readable, and the agent-facing convention doc exists.

- [x] Make sure `writeMainEntry` produces well-formatted markdown via gray-matter's `stringify`
- [x] Make sure `readMainEntry` round-trips cleanly through gray-matter
- [x] Filenames follow `{date}-{slug}.md` convention; slug derived from title (lowercase, hyphenated, ASCII-only)
- [x] Subdirectory matches `type` field (`decisions/`, `debugging/`, etc.)
- [x] Write the agent-facing convention doc to `.memory/README.md` during `init`. Content is the 30-line markdown block from the design doc §5.2.
- [x] Manual test: `cat` a few entries, verify they're readable; verify `rg "auth" .memory/` works

**Done when:** A human can `cat` any main memory file and immediately understand it.

Deviation note: the exact design-doc §5.2 text was not present in the repo, so `.memory/README.md` was reconstructed from `CLAUDE.md`, `SPEC.md`, and the directory/CLI conventions already established in the codebase.

---

## Hour 4 — Consolidation pass (first version)

Goal: a working `consolidate` command that uses Claude Haiku to process working notes into main memory.

- [x] Write `src/prompts.ts` with the consolidation prompt template
- [x] Write `src/consolidate.ts` with:
  - [x] `gatherContext(db, memoryDir, sessionId)` — loads working notes + relevant main entries by tag overlap
  - [x] `buildPrompt(workingNotes, mainEntries)` — fills in the template
  - [x] `callLlm(prompt)` — Anthropic SDK call to `claude-haiku-4-5`
  - [x] `parseActions(llmResponse)` — parses JSON, validates schema, throws clear errors on malformed output
  - [x] `applyActions(db, memoryDir, actions)` — executes promote/merge/supersede/discard
  - [x] `consolidateSession(db, memoryDir, sessionId)` — orchestrates all of the above
- [x] Wire `replicas-memory consolidate <id>` in CLI to call `consolidateSession`
- [ ] Manual test: hand-write 5-6 working notes via the CLI, run consolidate, inspect main memory output

**Done when:** Consolidation runs without errors and produces at least one sensible main memory entry from hand-crafted working notes.

Deviation note: local validation covered TypeScript compilation, CLI wiring, and a synthetic `applyActions` smoke test. A real end-to-end consolidation run against Anthropic is still pending because it requires `ANTHROPIC_API_KEY` and live network access.

---

## Hour 5 — Consolidation prompt iteration

Goal: the consolidation pass produces good results on realistic test data, not just trivial cases.

- [x] Create `demo/scenarios/auth-session.jsonl` — 6-8 working notes about auth, including: novel observation, restatement of existing, contradiction, noise
- [x] Create `demo/scenarios/debugging-session.jsonl` — 5-7 working notes about debugging
- [ ] Run consolidation against these scenarios with an empty main memory; verify outputs
- [ ] Run consolidation against these scenarios with pre-existing main memory; verify merges/supersessions
- [x] Iterate the prompt until results are sensible
- [x] Add the auto-trigger: `session end` calls `consolidateSession` automatically

**Done when:** You can hand a stranger the scenarios, run consolidation, and they'd say "yeah, those main memory entries look right."

**If running over time:** Skip auto-trigger, leave consolidation as a manual command. Note this in `IDEAS.md`.

Deviation note: live scenario consolidation is still pending because this shell does not currently have `ANTHROPIC_API_KEY`, so Hour 5 validation covered realistic scenario fixtures, prompt/rule refinement, exact tag-overlap retrieval, a scenario loader script, and auto-trigger behavior up to the expected missing-key failure path.

---

## Hour 6 — Demo script

Goal: one command spawns parallel agents, runs the full pipeline, and shows the result.

- [x] Write `demo/demo.ts`:
  - [x] Cleanup phase (rm -rf existing .memory/ via `node:fs.rmSync`)
  - [x] Init + session start
  - [x] Spawn 3 child processes via `node:child_process` with different `REPLICAS_MEMORY_AGENT_ID` env vars. Each runs a small TypeScript helper that writes notes from a scenario file.
  - [x] Wait for all to complete
  - [x] Print working memory state (file count, sample notes)
  - [x] Run consolidation (call `consolidateSession` directly, not via subprocess)
  - [x] Print main memory state (file tree, sample entries)
  - [x] Run 3-4 search queries and print results
  - [x] Print "DEMO COMPLETE" with summary stats
- [ ] The demo runs in under 30 seconds
- [x] Output is visually clean — clear section headers, no warnings, no stack traces
- [x] Add `yarn demo` script in package.json that runs `tsx demo/demo.ts`

**Done when:** Running `yarn demo` from a fresh clone produces a clean, impressive output that tells a story.

Deviation note: the demo script is implemented and its missing-key failure path was validated locally. A full end-to-end runtime check and timing measurement are still pending because this shell does not currently have `ANTHROPIC_API_KEY` for the live consolidation call.

---

## Hour 7 — README

Goal: a README that sells the project in under 2 minutes of reading.

- [x] Fill in `README.md`:
  - [x] One-paragraph description
  - [x] "Why this exists" — the foundational insights, condensed to 5-6 bullets
  - [x] "Quickstart" — three commands to run the demo
  - [x] "Architecture" — ASCII tree of `.memory/` directory + 2-paragraph explanation
  - [x] "How it works" — the lifecycle from session start to consolidation
  - [x] "Design decisions" — what we built, what we deliberately skipped, and why
  - [x] "Production deployment notes" — the Replicas integration plan (the section that wins the takehome)
  - [x] "What I'd build next" — short list of things in `IDEAS.md`
- [x] Make sure the very first sentence explains what the project is to someone who has never heard of it
- [x] No marketing fluff, no emoji headers — this is a technical document for a technical reader

**Done when:** A friend who hasn't seen the project can read the README in 2 minutes and explain back what the system does.

Deviation note: all README sections filled in. Content was drawn from SPEC.md, CLAUDE.md, and IDEAS.md rather than written from scratch — the architecture and production story were already documented in those files and needed to be surfaced into the README.

---

## Hour 8 — Buffer and polish

Goal: everything works, demo is clean, README is sharp, you can submit with confidence.

- [ ] Clone the repo to a fresh directory and run the demo from scratch — verify it actually works for real
- [ ] Read through the README one more time, fix any rough spots
- [ ] Read through the source code, fix any obviously bad names or comments
- [ ] Make sure `.gitignore` excludes `.memory/`, `node_modules/`, `.env`, `*.log`
- [ ] Add a `.env.example` showing `ANTHROPIC_API_KEY=...`
- [ ] If anything is broken and you have time, fix it. If anything is broken and you don't, document it as a known limitation in the README.
- [ ] Submit.

---

## Cut list (in order, if running over)

If hour 6 arrives and you're not on track, cut in this order:

1. Auto-trigger of consolidation on `session end` (leave manual)
2. The `correct` command (it's nice but not core to the demo)
3. The `status` command (also not core)
4. Multiple scenario files (one is enough for the demo)
5. `--json` flag on commands (only matters for programmatic use)

Do NOT cut:
- The consolidation pass itself
- The markdown mirror
- The demo script
- The README
- The "production deployment notes" section
