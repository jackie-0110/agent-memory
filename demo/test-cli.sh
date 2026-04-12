#!/usr/bin/env bash
# test-cli.sh — exercises every replicas-memory command against this repo
# Usage: bash demo/test-cli.sh
# Requires: LITELLM_API_KEY in environment (for session end / consolidation)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEMORY_DIR="$REPO_DIR/.memory-test-cli"
CLI="$REPO_DIR/bin/replicas-memory --memory-dir $MEMORY_DIR"

DIVIDER="════════════════════════════════════════════════════════════════"
THIN="────────────────────────────────────────────────────────────────"

hr()   { echo -e "\n$DIVIDER\n  $1\n$DIVIDER"; }
step() { echo -e "\n$THIN\n  $1\n$THIN"; }

# ── Cleanup from any previous run ─────────────────────────────────
rm -rf "$MEMORY_DIR"

hr "replicas-memory — CLI test"

# ── init ──────────────────────────────────────────────────────────
step "init"
$CLI init
echo "✓ init"

# ── session start ─────────────────────────────────────────────────
step "session start"
SESSION_ID=$($CLI session start "cli-test-session")
echo "Session ID: $SESSION_ID"
export REPLICAS_MEMORY_SESSION_ID="$SESSION_ID"
export REPLICAS_MEMORY_AGENT_ID="agent-test"

# ── note (various types and confidence levels) ────────────────────
step "note — writing 6 working notes"

$CLI note "The consolidation pass uses FTS5 bm25 ranking to surface the most relevant existing entries before calling the LLM." \
  --tags "architecture,search,fts5" --type observation --confidence high

$CLI note "Working notes are never locked — each agent appends to its own JSONL file, so parallel writes are safe without coordination." \
  --tags "architecture,concurrency,working-memory" --type decision --confidence high

$CLI note "gray-matter stringify is used to write frontmatter markdown; it must round-trip cleanly through gray-matter parse." \
  --tags "convention,markdown,frontmatter" --type convention --confidence medium

$CLI note "I first suspected the FTS5 snippet function caused the slow search, but profiling showed the JOIN was the bottleneck. FTS5 itself is fast." \
  --tags "debugging,fts5,performance" --type debugging --confidence high

$CLI note "Maybe we should add embedding-based search for paraphrase handling — FTS5 misses synonyms." \
  --tags "search,embeddings" --type hypothesis --confidence low

$CLI note "How does session cleanup work when a VM crashes mid-session without calling session end?" \
  --tags "architecture,session,reliability" --type question --confidence low

echo "✓ 6 notes written"

# ── status ────────────────────────────────────────────────────────
step "status"
$CLI status

# ── stats (before consolidation) ─────────────────────────────────
step "stats (no main memory yet)"
$CLI stats

# ── correct ───────────────────────────────────────────────────────
step "correct"
$CLI correct \
  "assumed FTS5 snippet was slow" \
  "the JOIN between memory_fts and memory_main was the bottleneck, not FTS5" \
  "profiling showed FTS5 itself is fast; the fix is to optimize the JOIN"
echo "✓ correction appended"

# ── session list ─────────────────────────────────────────────────
step "session list"
$CLI session list

# ── session end (triggers consolidation) ─────────────────────────
step "session end (consolidates via LLM)"
echo "  Running consolidation — this calls the LLM..."
$CLI session end "$SESSION_ID"

# ── stats (after consolidation) ──────────────────────────────────
step "stats (after consolidation)"
$CLI stats

# ── search ───────────────────────────────────────────────────────
step "search"
echo "  Query: 'parallel agent writes'"
$CLI search "parallel agent writes" --limit 3

echo ""
echo "  Query: 'FTS5 search performance'"
$CLI search "FTS5 search performance" --limit 3

echo ""
echo "  Query: 'markdown frontmatter'"
$CLI search "markdown frontmatter" --limit 3

# ── read (first result) ──────────────────────────────────────────
step "read (first search result by id)"
FIRST_ID=$($CLI search "parallel agent" --json --limit 1 | grep '"id"' | head -1 | grep -o '[0-9]*')
if [[ -n "$FIRST_ID" ]]; then
  $CLI read "$FIRST_ID"
  echo "✓ read entry $FIRST_ID"
else
  echo "  (no entries to read — consolidation may have discarded all notes)"
fi

# ── JSON output ──────────────────────────────────────────────────
step "search --json"
$CLI search "architecture" --json --limit 2

# ── Cleanup ───────────────────────────────────────────────────────
echo ""
echo "$DIVIDER"
echo "  DONE — cleaning up $MEMORY_DIR"
echo "$DIVIDER"
rm -rf "$MEMORY_DIR"
