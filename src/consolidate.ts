import Database from 'better-sqlite3';

import { buildConsolidationPrompt } from './prompts.ts';
import {
  archiveWorkingNotes,
  getMainEntry,
  getSession,
  listMainEntriesByTags,
  markSessionConsolidated,
  readWorkingNotes,
  updateMainEntry,
  writeMainEntry,
} from './store.ts';
import type { ConsolidationAction, MainEntry, WorkingNote } from './types.ts';

export interface ConsolidationContext {
  workingNotes: WorkingNote[];
  relatedEntries: MainEntry[];
}

export interface ConsolidationResult {
  actionsApplied: number;
  archivedFiles: number;
  summary: string;
  actions: ConsolidationAction[];
  workingNotes: WorkingNote[];
}

const VALID_ACTIONS = new Set<ConsolidationAction['action']>(['PROMOTE', 'MERGE', 'SUPERSEDE', 'DISCARD']);
const VALID_MAIN_TYPES = new Set<MainEntry['type']>(['decision', 'debugging', 'convention', 'architecture']);
const VALID_CONFIDENCE = new Set<MainEntry['confidence']>(['low', 'medium', 'high']);

export function gatherContext(
  db: Database.Database,
  memoryDir: string,
  sessionId: string,
): ConsolidationContext {
  getSession(db, sessionId);
  const workingNotes = readWorkingNotes(memoryDir, sessionId);
  const allTags = [...new Set(workingNotes.flatMap((note) => note.tags))];
  const relatedEntries = listMainEntriesByTags(db, allTags, 30);

  return { workingNotes, relatedEntries };
}

function stripJsonFences(responseText: string): string {
  const trimmed = responseText.trim();

  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
  }

  return trimmed;
}

function ensureNewEntry(value: unknown, action: ConsolidationAction['action']): ConsolidationAction['new_entry'] {
  if (!value || typeof value !== 'object') {
    throw new Error(`Action ${action} requires a valid new_entry object.`);
  }

  const record = value as Record<string, unknown>;
  const { type, title, content, tags, confidence } = record;

  if (!VALID_MAIN_TYPES.has(type as MainEntry['type'])) {
    throw new Error(`Invalid new_entry type: ${String(type)}.`);
  }

  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('new_entry.title must be a non-empty string.');
  }

  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('new_entry.content must be a non-empty string.');
  }

  if (!Array.isArray(tags)) {
    throw new Error('new_entry.tags must be an array of strings.');
  }

  const normalizedTags = tags.map((tag) => String(tag).trim()).filter(Boolean);

  if (!VALID_CONFIDENCE.has(confidence as MainEntry['confidence'])) {
    throw new Error(`Invalid new_entry confidence: ${String(confidence)}.`);
  }

  return {
    type: type as MainEntry['type'],
    title: title.trim(),
    content: content.trim(),
    tags: normalizedTags,
    confidence: confidence as MainEntry['confidence'],
  };
}

function validateActionCoverage(actions: ConsolidationAction[], workingNoteCount: number): void {
  if (actions.length !== workingNoteCount) {
    throw new Error(`Expected ${workingNoteCount} actions, but received ${actions.length}.`);
  }

  const seenIndexes = new Set<number>();

  for (const action of actions) {
    if (action.working_note_index < 0 || action.working_note_index >= workingNoteCount) {
      throw new Error(`Action references unknown working note index ${action.working_note_index}.`);
    }

    if (seenIndexes.has(action.working_note_index)) {
      throw new Error(`Duplicate action for working note index ${action.working_note_index}.`);
    }

    seenIndexes.add(action.working_note_index);
  }

  for (let index = 0; index < workingNoteCount; index += 1) {
    if (!seenIndexes.has(index)) {
      throw new Error(`Missing action for working note index ${index}.`);
    }
  }
}

export function parseActions(responseText: string): ConsolidationAction[] {
  const parsed = JSON.parse(stripJsonFences(responseText)) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Consolidation response must be a JSON array.');
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Action ${index} is not a JSON object.`);
    }

    const record = item as Record<string, unknown>;
    const workingNoteIndex = record.working_note_index;
    const action = record.action;
    const targetEntryId = record.target_entry_id;
    const rationale = record.rationale;

    if (!Number.isInteger(workingNoteIndex)) {
      throw new Error(`Action ${index} has an invalid working_note_index.`);
    }

    if (!VALID_ACTIONS.has(action as ConsolidationAction['action'])) {
      throw new Error(`Action ${index} has invalid action "${String(action)}".`);
    }

    if (targetEntryId !== null && targetEntryId !== undefined && !Number.isInteger(targetEntryId)) {
      throw new Error(`Action ${index} has an invalid target_entry_id.`);
    }

    if (typeof rationale !== 'string' || rationale.trim() === '') {
      throw new Error(`Action ${index} must include a non-empty rationale.`);
    }

    const normalizedWorkingNoteIndex = workingNoteIndex as number;
    const normalizedAction = action as ConsolidationAction['action'];
    const newEntry =
      record.new_entry === null || record.new_entry === undefined ? null : ensureNewEntry(record.new_entry, normalizedAction);

    if ((normalizedAction === 'PROMOTE' || normalizedAction === 'SUPERSEDE') && !newEntry) {
      throw new Error(`Action ${index} must include new_entry for ${normalizedAction}.`);
    }

    if ((normalizedAction === 'MERGE' || normalizedAction === 'SUPERSEDE') && !Number.isInteger(targetEntryId)) {
      throw new Error(`Action ${index} must include target_entry_id for ${normalizedAction}.`);
    }

    return {
      working_note_index: normalizedWorkingNoteIndex,
      action: normalizedAction,
      target_entry_id: targetEntryId === undefined ? null : (targetEntryId as number | null),
      new_entry: newEntry,
      rationale: rationale.trim(),
    };
  });
}

function mergeSources(existing: MainEntry['sources'], sessionId: string, agentId: string): MainEntry['sources'] {
  const match = existing.find((source) => source.session === sessionId);

  if (!match) {
    return [...existing, { session: sessionId, agents: [agentId] }];
  }

  if (!match.agents.includes(agentId)) {
    match.agents = [...match.agents, agentId].sort();
  }

  return existing;
}

function mergeContent(existingContent: string, incomingContent?: string | null): string {
  if (!incomingContent) {
    return existingContent;
  }

  if (existingContent.includes(incomingContent)) {
    return existingContent;
  }

  return `${existingContent.trim()}\n\n${incomingContent.trim()}`;
}

async function callLlm(prompt: string): Promise<string> {
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiKey) {
    throw new Error('LITELLM_API_KEY is required to run consolidation.');
  }

  const baseUrl = process.env.LITELLM_BASE_URL ?? 'https://api.ai.it.ufl.edu';
  const model = process.env.LITELLM_MODEL ?? 'gpt-4o-mini';

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LiteLLM API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const text = data.choices[0]?.message?.content?.trim();

  if (!text) {
    throw new Error('LiteLLM returned an empty consolidation response.');
  }

  return text;
}

export function applyActions(
  db: Database.Database,
  memoryDir: string,
  sessionId: string,
  actions: ConsolidationAction[],
): number {
  const { workingNotes } = gatherContext(db, memoryDir, sessionId);
  validateActionCoverage(actions, workingNotes.length);

  const run = db.transaction((parsedActions: ConsolidationAction[]) => {
    let actionsApplied = 0;

    for (const action of parsedActions) {
      const note = workingNotes[action.working_note_index];

      if (!note) {
        throw new Error(`Action references unknown working note index ${action.working_note_index}.`);
      }

      const timestamp = new Date().toISOString();

      if (action.action === 'DISCARD') {
        continue;
      }

      if (action.action === 'PROMOTE') {
        writeMainEntry(db, {
          ...action.new_entry!,
          created_at: timestamp,
          last_verified: timestamp,
          superseded_by: null,
          sources: [{ session: sessionId, agents: [note.agent_id] }],
          file_path: '',
        });
        actionsApplied += 1;
        continue;
      }

      const targetEntry = getMainEntry(db, action.target_entry_id!);
      const mergedSources = mergeSources([...targetEntry.sources], sessionId, note.agent_id);

      if (action.action === 'MERGE') {
        updateMainEntry(db, {
          ...targetEntry,
          id: targetEntry.id!,
          content: mergeContent(targetEntry.content, action.new_entry?.content ?? null),
          tags: [...new Set([...targetEntry.tags, ...(action.new_entry?.tags ?? note.tags)])],
          confidence: action.new_entry?.confidence ?? targetEntry.confidence,
          last_verified: timestamp,
          sources: mergedSources,
        });
        actionsApplied += 1;
        continue;
      }

      const replacementId = writeMainEntry(db, {
        ...action.new_entry!,
        created_at: timestamp,
        last_verified: timestamp,
        superseded_by: null,
        sources: [{ session: sessionId, agents: [note.agent_id] }],
        file_path: '',
      });

      updateMainEntry(db, {
        ...targetEntry,
        id: targetEntry.id!,
        superseded_by: replacementId,
        last_verified: timestamp,
        sources: mergedSources,
      });
      actionsApplied += 1;
    }

    return actionsApplied;
  });

  return run(actions);
}

export async function consolidateSession(
  db: Database.Database,
  memoryDir: string,
  sessionId: string,
): Promise<ConsolidationResult> {
  const context = gatherContext(db, memoryDir, sessionId);

  if (context.workingNotes.length === 0) {
    throw new Error(`No working notes found for session ${sessionId}.`);
  }

  const prompt = buildConsolidationPrompt(context.workingNotes, context.relatedEntries);
  const responseText = await callLlm(prompt);
  const actions = parseActions(responseText);
  const actionsApplied = applyActions(db, memoryDir, sessionId, actions);
  const archivedFiles = archiveWorkingNotes(memoryDir, sessionId);
  markSessionConsolidated(db, sessionId);

  return {
    actionsApplied,
    archivedFiles,
    summary: `Consolidated ${context.workingNotes.length} working notes into ${actionsApplied} main-memory changes.`,
    actions,
    workingNotes: context.workingNotes,
  };
}
