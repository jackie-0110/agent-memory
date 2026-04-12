import type { MainEntry, WorkingNote } from './types.ts';

function formatWorkingNotes(workingNotes: WorkingNote[]): string {
  return workingNotes
    .map((note, index) =>
      [
        `#${index}`,
        `agent=${note.agent_id}`,
        `ts=${note.ts}`,
        `type=${note.type}`,
        `confidence=${note.confidence}`,
        `tags=${note.tags.join(', ') || 'none'}`,
        `content=${note.content}`,
      ].join(' | '),
    )
    .join('\n');
}

function formatMainEntries(mainEntries: MainEntry[]): string {
  if (mainEntries.length === 0) {
    return 'No existing main-memory entries matched the working-note tags.';
  }

  return mainEntries
    .map((entry) =>
      [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `title=${entry.title}`,
        `confidence=${entry.confidence}`,
        `tags=${entry.tags.join(', ') || 'none'}`,
        `content=${entry.content}`,
      ].join(' | '),
    )
    .join('\n');
}

export function buildConsolidationPrompt(workingNotes: WorkingNote[], mainEntries: MainEntry[]): string {
  return `You are consolidating an agent session's working memory into durable shared memory for a coding agent system.

Working memory from this session:
${formatWorkingNotes(workingNotes)}

Existing relevant main-memory entries:
${formatMainEntries(mainEntries)}

Decide what should happen to each working note. Output a JSON array with exactly one action per working note.

Each object must follow this schema:
{
  "working_note_index": <integer>,
  "action": "PROMOTE" | "MERGE" | "SUPERSEDE" | "DISCARD",
  "target_entry_id": <integer or null>,
  "new_entry": {
    "type": "decision" | "debugging" | "convention" | "architecture",
    "title": "<5-10 word title>",
    "content": "<compressed lesson, not transcript>",
    "tags": ["tag1", "tag2"],
    "confidence": "low" | "medium" | "high"
  } | null,
  "rationale": "<one sentence>"
}

Rules:
1. Be conservative. Prefer PROMOTE over DISCARD when a note contains a reusable lesson.
2. Prefer MERGE when a note strengthens or clarifies an existing memory entry.
3. Use SUPERSEDE only when an existing entry is now materially wrong.
4. Reward convergence. Independent repeated observations should increase confidence.
5. Write compressed durable knowledge, not raw session transcripts.
6. If a note explicitly corrects an earlier assumption, prefer MERGE or SUPERSEDE over keeping both ideas alive.
7. DISCARD unresolved questions, temporary scratch work, and code facts that are trivial to re-discover.
8. For PROMOTE and SUPERSEDE, new_entry is required.
9. For MERGE, include new_entry when the existing entry should gain concrete content; otherwise set it to null.
10. Output strict JSON only. No markdown fences.`;
}
