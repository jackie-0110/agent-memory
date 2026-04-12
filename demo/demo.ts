import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { consolidateSession } from '../src/consolidate.ts';
import { createSession, endSession, initDb, readMainEntry, readWorkingNotes, searchMain } from '../src/store.ts';

const memoryDir = resolve(process.cwd(), '.memory');
const repoRoot = resolve(process.cwd());
const agentIds = ['agent-1', 'agent-2', 'agent-3'];
const searchQueries = ['refresh token', 'middleware claims', 'websocket 401', 'debugging handshake'];

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for yarn demo. Set it before running the end-to-end demo.');
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

function runLoader(agentId: string, scenarioPath: string, sessionId: string): Promise<string> {
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

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      rejectPromise(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `Loader failed for ${agentId}.`));
        return;
      }

      resolvePromise(stdout.trim());
    });
  });
}

function printWorkingState(sessionId: string): number {
  const workingNotes = readWorkingNotes(memoryDir, sessionId);
  const workingFiles = readdirSync(join(memoryDir, 'working')).filter((fileName) => fileName.endsWith('.jsonl'));

  printSection('Working Memory');
  console.log(`Files: ${workingFiles.length}`);
  console.log(`Notes: ${workingNotes.length}`);

  for (const note of workingNotes.slice(0, 5)) {
    console.log(`- ${note.agent_id} [${note.type}] ${note.content}`);
  }

  return workingNotes.length;
}

function listMainFiles(): string[] {
  const root = join(memoryDir, 'main');
  const collected: string[] = [];

  for (const directory of readdirSync(root)) {
    const directoryPath = join(root, directory);
    for (const fileName of readdirSync(directoryPath)) {
      collected.push(join(directoryPath, fileName));
    }
  }

  return collected.sort();
}

function printMainState(): number {
  const mainFiles = listMainFiles();

  printSection('Main Memory');
  console.log(`Entries: ${mainFiles.length}`);

  for (const filePath of mainFiles) {
    console.log(`- ${relative(memoryDir, filePath)}`);
  }

  for (const samplePath of mainFiles.slice(0, 2)) {
    const entry = readMainEntry(samplePath);
    console.log(`\n# ${entry.title}`);
    console.log(entry.content);
  }

  return mainFiles.length;
}

function printSearchResults(): void {
  const db = initDb(memoryDir);

  printSection('Search Results');
  for (const query of searchQueries) {
    const results = searchMain(db, query, 3);
    console.log(`\nQuery: ${query}`);

    if (results.length === 0) {
      console.log('  No hits');
      continue;
    }

    for (const result of results) {
      console.log(`  - ${result.title} (${relative(repoRoot, result.file_path)})`);
    }
  }

  db.close();
}

async function main(): Promise<void> {
  requireApiKey();

  rmSync(memoryDir, { recursive: true, force: true });

  printSection('Setup');
  console.log(runCli(['init', '--memory-dir', memoryDir]));

  const db = initDb(memoryDir);
  const session = createSession(db, 'parallel-demo');
  console.log(`Started session ${session.id}`);

  printSection('Agents');
  const loaderRuns = await Promise.all(
    agentIds.map((agentId) =>
      Promise.all([
        runLoader(agentId, 'demo/scenarios/auth-session.jsonl', session.id),
        runLoader(agentId, 'demo/scenarios/debugging-session.jsonl', session.id),
      ]),
    ),
  );

  for (const outputs of loaderRuns) {
    for (const line of outputs) {
      console.log(`- ${line}`);
    }
  }

  const workingNoteCount = printWorkingState(session.id);

  printSection('Consolidation');
  endSession(db, session.id);
  const consolidation = await consolidateSession(db, memoryDir, session.id);
  console.log(consolidation.summary);
  console.log(`Archived working files: ${consolidation.archivedFiles}`);

  const mainEntryCount = printMainState();
  printSearchResults();

  db.close();

  printSection('DEMO COMPLETE');
  console.log(`Session: ${session.id}`);
  console.log(`Working notes processed: ${workingNoteCount}`);
  console.log(`Main memory entries: ${mainEntryCount}`);
  console.log(`Memory directory: ${memoryDir}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
