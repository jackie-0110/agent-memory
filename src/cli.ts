import { Command, Option } from 'commander';
import { resolve } from 'node:path';

import { consolidateSession } from './consolidate.ts';
import { resolveSessionContext } from './session.ts';
import {
  appendCorrection,
  appendWorkingNote,
  createSession,
  endSession,
  getSession,
  getMainEntryFilePath,
  initDb,
  listSessions,
  readMainEntry,
  readWorkingNotes,
  searchMain,
} from './store.ts';
import type { Confidence, SearchResult, Session, WorkingNoteType } from './types.ts';

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

function registerCommonOptions(command: Command): Command {
  return command
    .addOption(new Option('--memory-dir <path>', 'Memory directory path.').default(DEFAULT_MEMORY_DIR))
    .option('--json', 'Emit machine-readable JSON.');
}

function requireAgentId(agentId?: string): string {
  const resolvedAgentId = agentId ?? process.env.REPLICAS_MEMORY_AGENT_ID;

  if (!resolvedAgentId) {
    throw new Error('No agent ID provided. Pass --agent-id or set REPLICAS_MEMORY_AGENT_ID in the environment.');
  }

  return resolvedAgentId;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('replicas-memory')
    .description('Persistent memory for parallel coding agents.')
    .showHelpAfterError();

  registerCommonOptions(
    program
      .command('init')
      .description('Initialize the .memory directory and SQLite database.'),
  ).action((options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    db.close();

    printOutput(
      options.json ? { ok: true, memoryDir } : `Initialized memory store at ${memoryDir}`,
      options.json,
    );
  });

  const session = program.command('session').description('Manage memory sessions.');

  registerCommonOptions(
    session
      .command('start')
      .argument('[name]')
      .description('Start a new session.'),
  ).action((name: string | undefined, options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const created = createSession(db, name);
    db.close();

    printOutput(options.json ? created : created.id, options.json);
  });

  registerCommonOptions(
    session
      .command('end')
      .argument('<session-id>')
      .description('End a session.'),
  ).action(async (sessionId: string, options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const ended = endSession(db, sessionId);
    const workingNoteCount = readWorkingNotes(memoryDir, sessionId).length;

    try {
      if (workingNoteCount === 0) {
        printOutput(
          options.json ? { session: ended, consolidation: null } : formatEndSession(ended, 'No working notes to consolidate.'),
          options.json,
        );
        return;
      }

      const consolidation = await consolidateSession(db, memoryDir, sessionId);
      const updatedSession = getSession(db, sessionId);
      printOutput(
        options.json ? { session: updatedSession, consolidation } : formatEndSession(updatedSession, consolidation.summary),
        options.json,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Session ${sessionId} was ended, but consolidation failed: ${message}`);
    } finally {
      db.close();
    }
  });

  registerCommonOptions(
    session
      .command('list')
      .description('List recent sessions.'),
  ).action((options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const sessions = listSessions(db);
    db.close();

    if (options.json) {
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
  ).action((content: string, options: NoteOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const { session } = resolveSessionContext(db, memoryDir, options.sessionId);
    const agentId = requireAgentId(options.agentId);

    appendWorkingNote(memoryDir, {
      ts: new Date().toISOString(),
      session_id: session.id,
      agent_id: agentId,
      type: options.type ?? 'observation',
      content,
      tags: parseTags(options.tags),
      confidence: options.confidence ?? 'medium',
    });

    db.close();

    printOutput(
      options.json
        ? { ok: true, session_id: session.id, agent_id: agentId, content, tags: parseTags(options.tags) }
        : `Wrote working note for ${session.id} (${agentId}).`,
      options.json,
    );
  });

  registerCommonOptions(
    program
      .command('search')
      .argument('<query>')
      .description('Search consolidated main memory.')
      .option('--limit <n>', 'Maximum number of results.', '5'),
  ).action((query: string, options: SearchOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const results = searchMain(db, query, parseLimit(options.limit));
    db.close();

    printOutput(options.json ? results : formatSearchResults(results), options.json);
  });

  registerCommonOptions(
    program
      .command('read')
      .argument('<file-path-or-id>')
      .description('Read a consolidated memory entry.'),
  ).action((filePathOrId: string, options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);

    const filePath =
      /^\d+$/.test(filePathOrId) ? getMainEntryFilePath(db, Number(filePathOrId)) : resolve(process.cwd(), filePathOrId);
    const entry = readMainEntry(filePath);

    db.close();

    if (options.json) {
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
    ) => {
      const memoryDir = resolveMemoryDir(options.memoryDir);
      initDb(memoryDir).close();

      appendCorrection(memoryDir, {
        session_id: options.sessionId ?? process.env.REPLICAS_MEMORY_SESSION_ID,
        agent_id: options.agentId ?? process.env.REPLICAS_MEMORY_AGENT_ID,
        context: options.context,
        agent_did: agentDid,
        user_corrected_to: shouldBe,
        rationale,
      });

      printOutput(
        options.json
          ? { ok: true, agent_did: agentDid, user_corrected_to: shouldBe }
          : 'Appended correction to corrections.jsonl.',
        options.json,
      );
    },
  );

  registerCommonOptions(
    program
      .command('consolidate')
      .argument('<session-id>')
      .description('Run the consolidation pass for a session.'),
  ).action(async (sessionId: string, options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const result = await consolidateSession(db, memoryDir, sessionId);
    db.close();

    printOutput(options.json ? result : result.summary, options.json);
  });

  registerCommonOptions(
    program
      .command('status')
      .description('Show current memory status.'),
  ).action((options: CommonOptions) => {
    const memoryDir = resolveMemoryDir(options.memoryDir);
    const db = initDb(memoryDir);
    const sessionId = process.env.REPLICAS_MEMORY_SESSION_ID;
    const sessions = listSessions(db);
    const summary: StatusSummary = {
      memoryDir,
      sessionId,
      workingNoteCount: sessionId ? readWorkingNotes(memoryDir, sessionId).length : 0,
      sessionCount: sessions.length,
      latestSession: sessions[0],
    };
    db.close();

    printOutput(options.json ? summary : formatStatus(summary), options.json);
  });

  await program.parseAsync();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
