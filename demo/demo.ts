import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { consolidateSession } from '../src/consolidate.ts';
import type { ConsolidationAction } from '../src/types.ts';
import { createSession, endSession, initDb, readMainEntry, readWorkingNotes, searchMain } from '../src/store.ts';
import type { WorkingNote } from '../src/types.ts';

const memoryDir = resolve(process.cwd(), '.memory');
const repoRoot = resolve(process.cwd());
const agentIds = ['agent-1', 'agent-2', 'agent-3'];
const searchQueries = ['refresh token', 'middleware claims', 'websocket 401', 'debugging handshake'];

const DIVIDER = '═'.repeat(64);
const THIN    = '─'.repeat(64);

function header(text: string): void {
  console.log(`\n${DIVIDER}`);
  console.log(`  ${text}`);
  console.log(DIVIDER);
}

function step(n: number, total: number, title: string): void {
  console.log(`\n[${n}/${total}] ${title}`);
}

function indent(text: string, spaces = 2): void {
  console.log(' '.repeat(spaces) + text);
}

function requireApiKey(): void {
  if (!process.env.LITELLM_API_KEY) {
    throw new Error('LITELLM_API_KEY is required for yarn demo. Set it before running the end-to-end demo.');
  }
}

function runCli(args: string[]): string {
  const result = spawnSync('corepack', ['yarn', 'tsx', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `CLI command failed: ${args.join(' ')}`);
  }

  return result.stdout.trim();
}

function runLoader(agentId: string, scenarioPath: string, sessionId: string): Promise<{ agentId: string; scenario: string; count: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'corepack',
      ['yarn', 'tsx', 'demo/load-scenario.ts', scenarioPath, sessionId, memoryDir, agentId],
      {
        cwd: repoRoot,
        env: { ...process.env, REPLICAS_MEMORY_AGENT_ID: agentId },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on('error', (error) => { rejectPromise(error); });
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `Loader failed for ${agentId}.`));
        return;
      }
      const match = /Loaded (\d+) notes/.exec(stdout);
      const scenarioName = scenarioPath.replace('demo/scenarios/', '').replace('.jsonl', '');
      resolvePromise({ agentId, scenario: scenarioName, count: match ? parseInt(match[1], 10) : 0 });
    });
  });
}

function listMainFiles(): string[] {
  const root = join(memoryDir, 'main');
  const collected: string[] = [];
  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    for (const file of readdirSync(dirPath)) {
      collected.push(join(dirPath, file));
    }
  }
  return collected.sort();
}

function printBox(title: string, subtitle: string, body: string): void {
  const width = 60;
  const pad = (s: string) => s.padEnd(width);
  console.log(`  ┌${'─'.repeat(width + 2)}┐`);
  console.log(`  │ ${pad(title)} │`);
  console.log(`  │ ${pad(subtitle)} │`);
  console.log(`  ├${'─'.repeat(width + 2)}┤`);
  for (const line of body.split('\n').slice(0, 6)) {
    console.log(`  │ ${pad(line.slice(0, width))} │`);
  }
  console.log(`  └${'─'.repeat(width + 2)}┘`);
}

function describeAction(action: ConsolidationAction, notes: WorkingNote[]): string {
  const note = notes[action.working_note_index];
  if (action.action === 'PROMOTE' || action.action === 'SUPERSEDE') {
    const title = action.new_entry?.title ?? '(untitled)';
    const type = action.new_entry?.type ?? '';
    const conf = action.new_entry?.confidence ?? '';
    return `${title.slice(0, 44)}  [${type} · ${conf}]`;
  }
  if (action.action === 'MERGE') {
    return `corroborates entry #${action.target_entry_id} — ${action.rationale.slice(0, 48)}`;
  }
  return `"${(note?.content ?? action.rationale).slice(0, 56)}"`;
}

const ACTION_ICON: Record<ConsolidationAction['action'], string> = {
  PROMOTE:   '↑ PROMOTE  ',
  MERGE:     '⇄ MERGE    ',
  SUPERSEDE: '⇉ SUPERSEDE',
  DISCARD:   '✗ DISCARD  ',
};

async function main(): Promise<void> {
  requireApiKey();

  rmSync(memoryDir, { recursive: true, force: true });

  header('replicas-memory  —  parallel agent demo');

  // ── Step 1: Setup ───────────────────────────────────────────
  step(1, 5, 'Setup');
  runCli(['init', '--memory-dir', memoryDir]);
  const db = initDb(memoryDir);
  const session = createSession(db, 'parallel-demo');
  indent(`Memory initialized at  .memory/`);
  indent(`Session:  ${session.id}`);

  // ── Step 2: Agents ──────────────────────────────────────────
  step(2, 5, 'Three agents working in parallel');
  indent('Each agent writes to its own JSONL file — no locks, no coordination.');
  console.log('');

  const loaderRuns = await Promise.all(
    agentIds.flatMap((agentId) => [
      runLoader(agentId, 'demo/scenarios/auth-session.jsonl', session.id),
      runLoader(agentId, 'demo/scenarios/debugging-session.jsonl', session.id),
    ]),
  );

  for (const { agentId, scenario, count } of loaderRuns) {
    indent(`${agentId.padEnd(10)}  ✓  ${String(count).padStart(2)} notes  (${scenario})`);
  }

  const workingNotes = readWorkingNotes(memoryDir, session.id);
  console.log('');
  indent(`${workingNotes.length} notes across ${agentIds.length} isolated files.  Sample:`);
  console.log('');
  for (const note of workingNotes.slice(0, 4)) {
    indent(`${note.agent_id}  [${note.type.padEnd(11)}]  ${note.content.slice(0, 60)}`, 4);
  }

  // ── Step 3: Consolidation ───────────────────────────────────
  step(3, 5, 'Consolidation pass');
  indent(`One LLM call reviews all ${workingNotes.length} notes — decides what belongs in long-term memory.`);
  console.log('');

  endSession(db, session.id);
  const result = await consolidateSession(db, memoryDir, session.id);

  // action type counts
  const counts: Record<string, number> = { PROMOTE: 0, MERGE: 0, SUPERSEDE: 0, DISCARD: 0 };
  for (const a of result.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  indent(
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ×${n}`)
      .join('   '),
  );
  console.log('');

  // show up to 6 example actions
  for (const action of result.actions.slice(0, 6)) {
    indent(`${ACTION_ICON[action.action]}  ${describeAction(action, result.workingNotes)}`, 4);
  }

  console.log('');
  indent(`${result.actionsApplied} actions applied.  ${result.archivedFiles} agent files archived to working/archive/.`);

  // ── Step 4: Main memory ─────────────────────────────────────
  step(4, 5, 'Main memory  (what agents will find next session)');
  const mainFiles = listMainFiles();

  const byDir: Record<string, number> = {};
  for (const f of mainFiles) {
    const dir = f.split('/').at(-2) ?? 'other';
    byDir[dir] = (byDir[dir] ?? 0) + 1;
  }

  indent(`${mainFiles.length} entries written:`);
  console.log('');
  for (const [dir, count] of Object.entries(byDir)) {
    indent(`${dir.padEnd(14)}  ${count} ${count === 1 ? 'entry' : 'entries'}`, 4);
  }

  const sampleFile = mainFiles[0];
  if (sampleFile) {
    const entry = readMainEntry(sampleFile);
    const agentList = entry.sources.flatMap((s) => s.agents).join(', ');
    console.log('');
    printBox(
      entry.title,
      `${entry.type} · ${entry.confidence} confidence · ${agentList}`,
      entry.content,
    );
  }

  // ── Step 5: Search ──────────────────────────────────────────
  step(5, 5, 'Search  (a new agent starts next session and queries)');
  console.log('');

  const searchDb = initDb(memoryDir);
  for (const query of searchQueries) {
    const hits = searchMain(searchDb, query, 3);
    if (hits.length === 0) {
      indent(`"${query}"`.padEnd(24) + '  no hits');
    } else {
      indent(`"${query}"`.padEnd(24) + `  →  ${hits[0].title}  [${hits[0].confidence}]`);
    }
  }
  searchDb.close();

  db.close();

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  indent(`DEMO COMPLETE`);
  console.log(THIN);
  indent(`${workingNotes.length} working notes  →  ${result.actionsApplied} main memory entries`);
  indent(`Any future agent can find this knowledge with replicas-memory search.`);
  console.log(DIVIDER);
  console.log('');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
