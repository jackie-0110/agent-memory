import chalk from 'chalk';
import { Command, Option } from 'commander';
import ora from 'ora';
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
import type { MemoryStats } from './store.ts';
import type { ConsolidationAction, Confidence, SearchResult, Session, WorkingNoteType } from './types.ts';

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

// ── Color helpers ────────────────────────────────────────────────

function confidenceColor(c: Confidence): string {
  if (c === 'high') return chalk.green(c);
  if (c === 'medium') return chalk.yellow(c);
  return chalk.red(c);
}

function confidenceDot(c: Confidence): string {
  if (c === 'high') return chalk.green('●');
  if (c === 'medium') return chalk.yellow('●');
  return chalk.red('●');
}

function bar(value: number, max: number, width = 12): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(Math.max(0, width - filled)));
}

// ── Formatters ───────────────────────────────────────────────────

function actionCountSummary(actions: ConsolidationAction[]): string {
  const counts: Record<string, number> = {};
  for (const a of actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

function formatSession(session: Session): string {
  return [
    `${chalk.dim('Session:')}      ${session.id}`,
    session.name ? `${chalk.dim('Name:')}         ${session.name}` : undefined,
    `${chalk.dim('Started:')}      ${session.started_at}`,
    session.ended_at
      ? `${chalk.dim('Ended:')}        ${session.ended_at}`
      : `${chalk.dim('Ended:')}        ${chalk.green('active')}`,
    session.consolidated_at
      ? `${chalk.dim('Consolidated:')} ${session.consolidated_at}`
      : `${chalk.dim('Consolidated:')} ${chalk.yellow('pending')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return chalk.dim('No matching main-memory entries found.');
  }

  return results
    .map((result, i) => {
      const badge = `${confidenceColor(result.confidence)} · ${chalk.dim(result.type)}`;
      return [
        `${chalk.dim(`[${i + 1}]`)}  ${chalk.bold(result.title)}  ${badge}`,
        `     ${chalk.dim(result.file_path)}`,
        `     ${result.snippet}`,
      ].join('\n');
    })
    .join('\n\n');
}

function formatStatus(status: StatusSummary): string {
  return [
    `${chalk.dim('Memory dir:')}               ${status.memoryDir}`,
    `${chalk.dim('Current session:')}          ${status.sessionId ?? chalk.dim('none')}`,
    `${chalk.dim('Working notes in session:')} ${status.workingNoteCount}`,
    `${chalk.dim('Known sessions:')}           ${status.sessionCount}`,
    status.latestSession
      ? `${chalk.dim('Latest session:')}           ${status.latestSession.id}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatStats(stats: MemoryStats, memoryDir: string): string {
  const typeMax = Math.max(0, ...Object.values(stats.byType));
  const typeLines = Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a)
    .map(([t, n]) => `  ${t.padEnd(14)} ${bar(n, typeMax)}  ${n}`)
    .join('\n') || `  ${chalk.dim('none')}`;

  const confMax = Math.max(0, ...Object.values(stats.byConfidence));
  const confLines = (['high', 'medium', 'low'] as Confidence[])
    .filter((c) => stats.byConfidence[c])
    .map((c) => {
      const n = stats.byConfidence[c] ?? 0;
      return `  ${confidenceDot(c)} ${c.padEnd(8)} ${bar(n, confMax)}  ${n}`;
    })
    .join('\n') || `  ${chalk.dim('none')}`;

  const topTagsLine =
    stats.topTags.map(({ tag, count }) => `${chalk.cyan(tag)} (${count})`).join('  ') ||
    chalk.dim('none');

  const staleWarning =
    stats.staleEntries > 0
      ? `  ${chalk.yellow(`⚠  ${stats.staleEntries} not re-verified in 14+ days`)}`
      : '';

  return [
    `${chalk.dim('Memory dir:')}   ${memoryDir}`,
    `${chalk.dim('Entries:')}      ${chalk.bold(String(stats.activeEntries))} active, ${stats.supersededEntries} superseded${staleWarning}`,
    '',
    chalk.dim('By type:'),
    typeLines,
    '',
    chalk.dim('By confidence:'),
    confLines,
    '',
    `${chalk.dim('Top tags:')}     ${topTagsLine}`,
    `${chalk.dim('Sessions:')}     ${stats.totalSessions} total, ${stats.consolidatedSessions} consolidated`,
  ].join('\n');
}

// ── Plumbing ─────────────────────────────────────────────────────

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

// ── Commands ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('replicas-memory')
    .description('Persistent memory for parallel coding agents.')
    .showHelpAfterError();

  registerCommonOptions(program);

  // init
  registerCommonOptions(
    program
      .command('init')
      .description('Initialize the .memory directory and SQLite database.'),
  ).action((_options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    withDb(memoryDir, () => undefined);

    printOutput(
      common.json
        ? { ok: true, memoryDir }
        : [
            `${chalk.green('✓')} Initialized ${chalk.bold(memoryDir)}`,
            chalk.dim('  working/   main/decisions/   main/debugging/   main/conventions/   main/architecture/'),
          ].join('\n'),
      common.json,
    );
  });

  const sessionCmd = program.command('session').description('Manage memory sessions.');

  // session start
  registerCommonOptions(
    sessionCmd
      .command('start')
      .argument('[name]')
      .description('Start a new session.'),
  ).action((name: string | undefined, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const created = withDb(memoryDir, (db) => createSession(db, name));

    printOutput(common.json ? created : created.id, common.json);
  });

  // session end
  registerCommonOptions(
    sessionCmd
      .command('end')
      .argument('[session-id]')
      .description('End a session and consolidate its working notes. Defaults to REPLICAS_MEMORY_SESSION_ID.'),
  ).action(async (sessionIdArg: string | undefined, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const sessionId = sessionIdArg ?? process.env.REPLICAS_MEMORY_SESSION_ID;

    if (!sessionId) {
      throw new Error('No session ID provided. Pass one explicitly or set REPLICAS_MEMORY_SESSION_ID.');
    }
    const noteCount = readWorkingNotes(memoryDir, sessionId).length;

    const spinner =
      !common.json && noteCount > 0
        ? ora(`Consolidating ${noteCount} working ${noteCount === 1 ? 'note' : 'notes'}...`).start()
        : null;

    try {
      const result = await withDbAsync(memoryDir, async (db) => {
        const ended = endSession(db, sessionId);

        if (noteCount === 0) {
          return { session: ended, consolidation: null };
        }

        const consolidation = await consolidateSession(db, memoryDir, sessionId);
        return { session: getSession(db, sessionId), consolidation };
      });

      if (common.json) {
        printOutput(result, true);
        return;
      }

      if (spinner && result.consolidation) {
        spinner.succeed(
          `Consolidated ${noteCount} notes  (${actionCountSummary(result.consolidation.actions)})`,
        );
      } else if (spinner) {
        spinner.succeed('Session ended');
      } else {
        console.log(chalk.dim('No working notes to consolidate.'));
      }

      console.log(formatSession(result.session));
    } catch (error: unknown) {
      spinner?.fail('Consolidation failed');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Session ${sessionId} was ended, but consolidation failed: ${message}`);
    }
  });

  // session list
  registerCommonOptions(
    sessionCmd
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

    const text =
      sessions.length === 0
        ? chalk.dim('No sessions found.')
        : sessions.map(formatSession).join('\n\n');
    printOutput(text, false);
  });

  // note
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
    const noteType = options.type ?? 'observation';
    const confidence = options.confidence ?? 'medium';
    const session = withDb(memoryDir, (db) => resolveSessionContext(db, memoryDir, options.sessionId).session);

    appendWorkingNote(memoryDir, {
      ts: new Date().toISOString(),
      session_id: session.id,
      agent_id: agentId,
      type: noteType,
      content,
      tags,
      confidence,
    });

    printOutput(
      common.json
        ? { ok: true, session_id: session.id, agent_id: agentId, content, tags }
        : `${chalk.green('✓')} ${chalk.dim(`[${noteType} · ${confidence}]`)}  ${chalk.cyan(tags.join(', '))}  →  ${session.id} (${agentId})`,
      common.json,
    );
  });

  // search
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

  // read
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

    printOutput(
      `${chalk.bold(entry.title)}  ${confidenceDot(entry.confidence)} ${confidenceColor(entry.confidence)} · ${chalk.dim(entry.type)}\n${chalk.dim(entry.file_path)}\n\n${entry.content}`,
      false,
    );
  });

  // correct
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
          : `${chalk.green('✓')} Correction appended to corrections.jsonl`,
        common.json,
      );
    },
  );

  // consolidate
  registerCommonOptions(
    program
      .command('consolidate')
      .argument('<session-id>')
      .description('Run the consolidation pass for a session.'),
  ).action(async (sessionId: string, _options: CommonOptions, command: Command) => {
    const common = getCommonOptions(command);
    const memoryDir = resolveMemoryDir(common.memoryDir);
    const noteCount = readWorkingNotes(memoryDir, sessionId).length;

    const spinner = !common.json
      ? ora(`Consolidating ${noteCount} working ${noteCount === 1 ? 'note' : 'notes'}...`).start()
      : null;

    try {
      const result = await withDbAsync(memoryDir, (db) => consolidateSession(db, memoryDir, sessionId));

      if (spinner) {
        spinner.succeed(`Consolidated ${noteCount} notes  (${actionCountSummary(result.actions)})`);
      } else {
        printOutput(result, true);
      }
    } catch (error: unknown) {
      spinner?.fail('Consolidation failed');
      throw error;
    }
  });

  // stats
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

  // status
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
  console.error(chalk.red(`Error: ${message}`));
  process.exitCode = 1;
});
