import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { appendWorkingNote } from '../src/store.ts';
import type { WorkingNote } from '../src/types.ts';

function main(): void {
  const scenarioPath = process.argv[2];
  const sessionId = process.argv[3] ?? process.env.REPLICAS_MEMORY_SESSION_ID;
  const memoryDir = resolve(process.cwd(), process.argv[4] ?? '.memory');
  const agentIdFilter = process.argv[5] ?? process.env.REPLICAS_MEMORY_AGENT_ID;

  if (!scenarioPath) {
    throw new Error('Usage: tsx demo/load-scenario.ts <scenario-path> [session-id] [memory-dir] [agent-id]');
  }

  if (!sessionId) {
    throw new Error('No session ID provided. Pass one explicitly or set REPLICAS_MEMORY_SESSION_ID.');
  }

  const raw = readFileSync(resolve(process.cwd(), scenarioPath), 'utf8').trim();
  if (!raw) {
    throw new Error(`Scenario file ${scenarioPath} is empty.`);
  }

  const notes = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkingNote)
    .filter((note) => !agentIdFilter || note.agent_id === agentIdFilter);

  if (notes.length === 0) {
    throw new Error(
      agentIdFilter
        ? `Scenario ${scenarioPath} has no notes for agent ${agentIdFilter}.`
        : `Scenario file ${scenarioPath} had no loadable notes.`,
    );
  }

  for (const note of notes) {
    appendWorkingNote(memoryDir, {
      ...note,
      session_id: sessionId,
    });
  }

  console.log(
    `Loaded ${notes.length} notes from ${basename(scenarioPath)} into ${sessionId}${agentIdFilter ? ` for ${agentIdFilter}` : ''}.`,
  );
}

main();
