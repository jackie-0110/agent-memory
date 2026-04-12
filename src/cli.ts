import { Command, Option } from 'commander';
import { resolve } from 'node:path';

import { consolidateSession } from './consolidate.ts';
import { resolveSessionContext } from './session.ts';
import {
  appendCorrection,
  appendWorkingNote,
  createSession,
  endSession,
  getMainEntryFilePath,
  getSession,
  getStats,
  initDb,
  listSessions,
  readMainEntry,
  readWorkingNotes,
  searchMain,
} from './store.ts';
import type { Confidence, SearchResult, Session, WorkingNoteType } from './types.ts';
import type { MemoryStats } from './store.ts';

interface CommonOptions {
  memoryDir: string;
  json?: boolean;
}

interface NoteOptions extends CommonOptions {
  tags?: string;
  type?: WorkingNoteType;
  confidence?: Confidence;
  sessionId?: string;
  agentId?: string;
}

interface SearchOptions extends CommonOptions {
  limit?: string;
}

interface StatusSummary {
  memoryDir: string;
  sessionId?: string;
  workingNoteCount: number;
  sessionCount: number;
  latestSession?: Session;
}

const DEFAULT_MEMORY_DIR = '.memory';
const WORKING_NOTE_TYPES: WorkingNoteType[] = [
  'observation',
  'decision',
  'debugging',
  'convention',
  'hypothesis',
  'question',
];
const CONFIDENCE_LEVELS: Confidence[] = ['low', 'medium', 'high'];

function resolveMemoryDir(memoryDir?: string): string {
  return resolve(process.cwd(), memoryDir ?? DEFAULT_MEMORY_DIR);
}

function parseTags(input?: string): string[] {
  return (input ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseLimit(value?: string): number {
  const parsed = Number(value ?? '5');

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit "${value}". Expected a positive integer.`);
  }

  return parsed;
}

function printOutput(payload: unknown, asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (typeof payload === 'string') {
    console.log(payload);
    return;
  }

  console.log(payload);
}

function formatSession(session: Session): string {
  return [
    `Session: ${session.id}`,
    session.name ? `Name: ${session.name}` : undefined,
    `Started: ${session.started_at}`,
    session.ended_at ? `Ended: ${session.ended_at}` : 'Ended: active',
    session.consolidated_at ? `Consolidated: ${session.consolidated_at}` : 'Consolidated: pending',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatEndSession(session: Session, consolidationSummary?: string): string {
  return [formatSession(session), consolidationSummary].filter(Boolean).join('\n');
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No matching main-memory entries found.';
  }

  return results
    .map(
      (result) =>
        [
          `${result.id}: ${result.title}`,
          `Path: ${result.file_path}`,
          `Confidence: ${result.confidence}`,
          `Verified: ${result.last_verified}`,
          `Snippet: ${result.snippet}`,
        ].join('\n'),
    )
    .join('\n\n');
}

function formatStatus(status: StatusSummary): string {
  return [
    `Memory dir: ${status.memoryDir}`,
    `Current session: ${status.sessionId ?? 'none'}`,
    `Working notes in current session: ${status.workingNoteCount}`,
    `Known sessions: ${status.sessionCount}`,
    status.latestSession ? `Latest session: ${status.latestSession.id}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatStats(stats: MemoryStats, memoryDir: string): string {
  const typeBreakdown = Object.entries(stats.byType)
    .map(([t, n]) => `${t}: ${n}`)
    .join('  ') || 'none';

  const confBreakdown = ['high', 'medium', 'low']
    .filter((c) => stats.byConfidence[c])
    .map((c) => `${c}: ${stats.byConfidence[c]}`)
    .join('  ') || 'none';

  const topTagsLine = stats.topTags.map(({ tag, count }) => `${tag} (${count})`).join('  ') || 'none';

  const staleNote = stats.staleEntries > 0 ? `  ⚠  ${stats.staleEntries} not re-verified in 14+ days` : '';

  return [
    `Memory dir:        ${memoryDir}`,
    `Entries:           ${stats.activeEntries} active, ${stats.supersededEntries} superseded${staleNote}`,
    `By type:           ${typeBreakdown}`,
    `By confidence:     ${confBreakdown}`,
    `Top tags:          ${topTagsLine}`,
    `Sessions:          ${stats.totalSessions} total, ${stats.consolidatedSessions} consolidated`,
  ].join('\n');
}

function registerCommonOptions(command: Command): Command {
  return command
    .addOption(new Option('--memory-dir <path>', 'Memory directory path.').default(DEFAULT_MEMORY_DIR))
    .option('--json', 'Emit machine-readable JSON.');
}

function getCommonOptions(command: Command): CommonOptions {
  const options = command.optsWithGlobals() as CommonOptions;
  return {
    memoryDir: options.memoryDir ?? DEFAULT_MEMORY_DIR,
    json: options.json ?? false,
  };
}

function requireAgentId(agentId?: string): string {
  const resolvedAgentId = agentId ?? process.env.REPLICAS_MEMORY_AGENT_ID;

  if (!resolvedAgentId) {
    throw new Error('No agent ID provided. Pass --agent-id or set REPLICAS_MEMORY_AGENT_ID in the environment.');
  }

  return resolvedAgentId;
}

function withDb<T>(memoryDir: string, run: (db: ReturnType<typeof initDb>) => T): T {
  const db = initDb(memoryDir);

  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function withDbAsync<T>(
  memoryDir: string,
  run: (db: ReturnType<typeof initDb>) => Promise<T>,
): Promise<T> {
  const db = initDb(memoryDir);

  try {
    return await run(db);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('replicas-memory')
    .description('Persistent memory for parallel coding agents.')
    .showHelpAfterError();

  registerCommonOptions(program);

  registerCommonOptions(
    program
      .command('init')
      .description('Initialize the .memory directory and SQLite database.'),
  ).action((_options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    withDb(memoryDir, () => undefined);

    printOutput(
      common.json ? { ok: true, memoryDir } : `Initialized memory store at ${memoryDir}`,
      common.json,
    );
  });

  const session = program.command('session').description('Manage memory sessions.');

  registerCommonOptions(
    session
      .command('start')
      .argument('[name]')
      .description('Start a new session.'),
  ).action((name: string | undefined, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const created = withDb(memoryDir, (db) => createSession(db, name));

    printOutput(common.json ? created : created.id, common.json);
  });

  registerCommonOptions(
    session
      .command('end')
      .argument('<session-id>')
      .description('End a session.'),
  ).action(async (sessionId: string, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const workingNoteCount = readWorkingNotes(memoryDir, sessionId).length;

    try {
      const result = await withDbAsync(memoryDir, async (db) => {
        const ended = endSession(db, sessionId);

        if (workingNoteCount === 0) {
          return { session: ended, consolidation: null };
        }

        const consolidation = await consolidateSession(db, memoryDir, sessionId);
        return {
          session: getSession(db, sessionId),
          consolidation,
        };
      });

      printOutput(
        common.json
          ? result
          : formatEndSession(result.session, result.consolidation?.summary ?? 'No working notes to consolidate.'),
        common.json,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Session ${sessionId} was ended, but consolidation failed: ${message}`);
    }
  });

  registerCommonOptions(
    session
      .command('list')
      .description('List recent sessions.'),
  ).action((_options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const sessions = withDb(memoryDir, (db) => listSessions(db));

    if (common.json) {
      printOutput(sessions, true);
      return;
    }

    const text = sessions.length === 0 ? 'No sessions found.' : sessions.map(formatSession).join('\n\n');
    printOutput(text, false);
  });

  registerCommonOptions(
    program
      .command('note')
      .argument('<content>')
      .description('Write a working-memory note.')
      .requiredOption('--tags <tag1,tag2>', 'Comma-separated tags.')
      .addOption(new Option('--type <type>', 'Working note type.').choices(WORKING_NOTE_TYPES).default('observation'))
      .addOption(
        new Option('--confidence <confidence>', 'Confidence level.').choices(CONFIDENCE_LEVELS).default('medium'),
      )
      .option('--session-id <id>', 'Session ID. Defaults to REPLICAS_MEMORY_SESSION_ID.')
      .option('--agent-id <id>', 'Agent ID. Defaults to REPLICAS_MEMORY_AGENT_ID.'),
  ).action((content: string, options: NoteOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const agentId = requireAgentId(options.agentId);
    const tags = parseTags(options.tags);
    const session = withDb(memoryDir, (db) => resolveSessionContext(db, memoryDir, options.sessionId).session);

    appendWorkingNote(memoryDir, {
      ts: new Date().toISOString(),
      session_id: session.id,
      agent_id: agentId,
      type: options.type ?? 'observation',
      content,
      tags,
      confidence: options.confidence ?? 'medium',
    });

    printOutput(
      common.json ? { ok: true, session_id: session.id, agent_id: agentId, content, tags } : `Wrote working note for ${session.id} (${agentId}).`,
      common.json,
    );
  });

  registerCommonOptions(
    program
      .command('search')
      .argument('<query>')
      .description('Search consolidated main memory.')
      .option('--limit <n>', 'Maximum number of results.', '5'),
  ).action((query: string, options: SearchOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const results = withDb(memoryDir, (db) => searchMain(db, query, parseLimit(options.limit)));

    printOutput(common.json ? results : formatSearchResults(results), common.json);
  });

  registerCommonOptions(
    program
      .command('read')
      .argument('<file-path-or-id>')
      .description('Read a consolidated memory entry.'),
  ).action((filePathOrId: string, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const filePath = /^\d+$/.test(filePathOrId)
      ? withDb(memoryDir, (db) => getMainEntryFilePath(db, Number(filePathOrId)))
      : resolve(process.cwd(), filePathOrId);
    const entry = readMainEntry(filePath);

    if (common.json) {
      printOutput(entry, true);
      return;
    }

    printOutput(`${entry.title}\n${entry.file_path}\n\n${entry.content}`, false);
  });

  registerCommonOptions(
    program
      .command('correct')
      .argument('<agent-did>')
      .argument('<should-be>')
      .argument('<rationale>')
      .description('Append a correction to the corrections log.')
      .option('--session-id <id>', 'Session ID. Defaults to REPLICAS_MEMORY_SESSION_ID.')
      .option('--agent-id <id>', 'Agent ID. Defaults to REPLICAS_MEMORY_AGENT_ID.')
      .option('--context <text>', 'Optional context for the correction.'),
  ).action(
    (
      agentDid: string,
      shouldBe: string,
      rationale: string,
      options: CommonOptions & { sessionId?: string; agentId?: string; context?: string },
      command: Command,
    ) => {
      const common = getCommonOptions(command);
      const memoryDir = resolveMemoryDir(common.memoryDir);
      withDb(memoryDir, () => undefined);

      appendCorrection(memoryDir, {
        session_id: options.sessionId ?? process.env.REPLICAS_MEMORY_SESSION_ID,
        agent_id: options.agentId ?? process.env.REPLICAS_MEMORY_AGENT_ID,
        context: options.context,
        agent_did: agentDid,
        user_corrected_to: shouldBe,
        rationale,
      });

      printOutput(
        common.json
          ? { ok: true, agent_did: agentDid, user_corrected_to: shouldBe }
          : 'Appended correction to corrections.jsonl.',
        common.json,
      );
    },
  );

  registerCommonOptions(
    program
      .command('consolidate')
      .argument('<session-id>')
      .description('Run the consolidation pass for a session.'),
  ).action(async (sessionId: string, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const result = await withDbAsync(memoryDir, (db) => consolidateSession(db, memoryDir, sessionId));

    printOutput(common.json ? result : result.summary, common.json);
  });

  registerCommonOptions(
    program
      .command('stats')
      .description('Show memory health statistics.'),
  ).action((_options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const stats = withDb(memoryDir, (db) => getStats(db));

    printOutput(common.json ? stats : formatStats(stats, memoryDir), common.json);
  });

  registerCommonOptions(
    program
      .command('status')
      .description('Show current memory status.'),
  ).action((_options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const sessionId = process.env.REPLICAS_MEMORY_SESSION_ID;
    const summary = withDb(memoryDir, (db) => {
      const sessions = listSessions(db);

      return {
        memoryDir,
        sessionId,
        workingNoteCount: sessionId ? readWorkingNotes(memoryDir, sessionId).length : 0,
        sessionCount: sessions.length,
        latestSession: sessions[0],
      };
    });

    printOutput(common.json ? summary : formatStatus(summary), common.json);
  });

  await program.parseAsync();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
