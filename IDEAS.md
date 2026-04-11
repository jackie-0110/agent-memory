# Ideas — Parking Lot

Anything that comes up during the build that isn't in `PLAN.md` goes here. Do NOT implement these during the takehome. They exist so you can capture good ideas without losing focus.

After the takehome ships, this list becomes the roadmap.

## Production / integration

- **Replicas integration** — see README "Production deployment notes" section. The full plan is documented and ready to implement.
- **Migrate from SQLite to Supabase Postgres** — drop-in replacement for the storage layer, `tsvector` replaces FTS5
- **Workspace integration** — add this as a package in the existing Replicas monorepo, expose as `replicas memory <subcommand>`
- **Cursor extension** — surface relevant memory entries inline as completion hints

## Memory quality

- **Confidence-weighted ranking** — boost search results from entries with `confidence: high` and from entries with multiple convergent sources
- **`verify` command** — run against the current codebase, mark entries as stale if their content contradicts what's actually in the code
- **Automatic re-consolidation** — periodically re-run the consolidation pass over old entries to merge or supersede based on newer information
- **Tag normalization** — surface a list of all tags currently in use, suggest merges for near-duplicates ("auth" + "authentication")

## Search

- **Hybrid retrieval** — combine FTS5 keyword search with embedding similarity for paraphrase handling. Only worth adding if FTS5 demonstrably fails on real queries.
- **Query expansion** — use the LLM to expand search queries before running FTS5 (e.g., "auth" → "auth authentication login token")
- **Semantic clustering** — group related entries in search results instead of returning a flat list

## UX

- **`init` interactive mode** — walk new users through setting up their first project memory
- **Progress indicators during consolidation** — the LLM call can take 5-10 seconds, show a spinner via `ora` (would need a new dep, ask first)
- **Pretty-printed search results** — colorize matched terms in snippets via `chalk` (would need a new dep, ask first)

## Concurrency / scale

- **Background consolidation worker** — daemon process that watches for ended sessions and consolidates them automatically
- **Session resumption** — let agents reattach to a session after disconnect, picking up their working memory file
- **Sharding by project** — when a single Supabase instance serves many projects, partition memory tables by `project_id`

## Observability

- **`stats` command** — show counts, sizes, recent activity, top tags
- **Consolidation audit log** — record every promote/merge/supersede/discard decision for later review
- **Cost tracking** — record token usage and dollar cost per consolidation pass

## Testing (post-takehome)

- **Unit tests for store.ts** — schema correctness, FTS5 query behavior, frontmatter round-tripping
- **Integration tests for consolidation** — golden-file tests with hand-crafted scenarios
- **Property tests** — ensure markdown round-trips through frontmatter parsing without loss

## Things to deliberately NOT build (ever)

These are anti-features. Listed here so future-me doesn't reconsider them.

- **General-purpose memory layer for non-coding agents.** The framework is opinionated about being for coding agents. Generalizing it would dilute it.
- **Vector embeddings as the primary storage.** Markdown stays the source of truth. Vector search is at most an additive index.
- **Cross-project memory.** Memory is per-project. Global user preferences belong somewhere else (like Cursor rules).
- **Plugins / pluggable backends.** Hard-coded substrates are the point. The day someone asks "can I use it with [other database]" the answer is "use a different framework."
- **A custom DSL for queries.** Search takes a string. The string goes to FTS5. That's the entire query interface.
- **A web UI.** `cat`, `rg`, and the CLI are the UI. A web view is a separate product.
- **An async API.** This is a CLI. Synchronous code is half the lines and easier to reason about.
