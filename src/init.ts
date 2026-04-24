import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { installHooks } from './installHooks.js';
import { scan } from './scan.js';
import { runAutoGroup } from './autoGroup.js';
import { closeDb } from './db.js';
import { log } from './log.js';
import { CLAUDE_SETTINGS, REEF_HOME } from './paths.js';

export interface InitOptions {
  skipHooks?: boolean;
  skipMcp?: boolean;
  skipScan?: boolean;
  skipAutogroup?: boolean;
}

export interface InitResult {
  hooks: { added: number; updated: number; backup: string | null } | null;
  mcp: { status: 'registered' | 'already' | 'skipped' | 'failed'; detail?: string };
  scan: { sessions: number; skipped: number; durationMs: number } | null;
  autogroup: {
    created: Array<{ group: string; projects: string[] }>;
    singletons: string[];
    alreadyGrouped: number;
  } | null;
}

function defaultCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'cli.js');
}

function tryRegisterMcp(cliPath: string): InitResult['mcp'] {
  // Must find the `claude` CLI on PATH — otherwise we can't register.
  const which = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['claude'],
    { encoding: 'utf8' },
  );
  if (which.status !== 0) {
    return {
      status: 'failed',
      detail:
        '`claude` CLI not found on PATH. Install Claude Code, or run this manually:\n' +
        `  claude mcp add reef -- node "${cliPath}" mcp`,
    };
  }

  // `claude mcp get reef` exits 0 when the server exists, non-zero when it
  // doesn't. Cleaner than parsing `mcp list` output across claude versions.
  const get = spawnSync('claude', ['mcp', 'get', 'reef'], { encoding: 'utf8' });
  if (get.status === 0) {
    return { status: 'already' };
  }

  // Use --scope user so reef is available in every Claude Code session,
  // not just the project directory where init was run. Without this,
  // `claude mcp add` defaults to local scope and reef silently "vanishes"
  // the moment the user opens a different project.
  const add = spawnSync(
    'claude',
    ['mcp', 'add', '--scope', 'user', 'reef', '--', 'node', cliPath, 'mcp'],
    { encoding: 'utf8' },
  );
  if (add.status !== 0) {
    return {
      status: 'failed',
      detail:
        (add.stderr || add.stdout || 'unknown error').trim() ||
        'claude mcp add failed',
    };
  }
  return { status: 'registered' };
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const result: InitResult = {
    hooks: null,
    mcp: { status: 'skipped' },
    scan: null,
    autogroup: null,
  };

  console.log('reef init — one-command setup\n');

  if (!opts.skipHooks) {
    console.log('[1/4] Installing Claude Code hooks…');
    const h = installHooks({});
    result.hooks = { added: h.added, updated: h.updated, backup: h.backupPath };
    console.log(`      added: ${h.added}, updated: ${h.updated}`);
    console.log(`      settings: ${h.settingsPath}`);
    if (h.backupPath) console.log(`      backup:   ${h.backupPath}`);
  }

  if (!opts.skipMcp) {
    console.log('\n[2/4] Registering MCP server with Claude Code…');
    const cliPath = defaultCliPath();
    result.mcp = tryRegisterMcp(cliPath);
    if (result.mcp.status === 'registered') {
      console.log('      ✓ registered');
    } else if (result.mcp.status === 'already') {
      console.log('      already registered (skipped)');
    } else {
      console.log('      ! ' + (result.mcp.detail ?? 'failed'));
    }
  }

  if (!opts.skipScan) {
    console.log('\n[3/4] Scanning transcripts…');
    const s = await scan({ force: false });
    result.scan = {
      sessions: s.sessionsUpserted,
      skipped: s.filesSkipped,
      durationMs: s.durationMs,
    };
    console.log(
      `      ${s.sessionsUpserted} upserted, ${s.filesSkipped} already fresh (${s.durationMs}ms)`,
    );
    closeDb();
  }

  if (!opts.skipAutogroup) {
    console.log('\n[4/4] Auto-grouping project folders…');
    const g = runAutoGroup({});
    result.autogroup = {
      created: g.created,
      singletons: g.skippedSingletons,
      alreadyGrouped: g.alreadyGrouped.length,
    };
    console.log(
      `      ${g.created.length} group(s) auto-created, ${g.alreadyGrouped.length} already grouped, ${g.skippedSingletons.length} singleton(s) left`,
    );
    for (const cluster of g.created) {
      console.log(`      + ${cluster.group}: ${cluster.projects.join(', ')}`);
    }
  }

  console.log('\nreef is live.');
  console.log(`  data dir   : ${REEF_HOME}`);
  console.log(`  settings   : ${CLAUDE_SETTINGS}`);
  if (result.mcp.status === 'registered' || result.mcp.status === 'already') {
    console.log('\nRestart Claude Code to load the MCP server, then try:');
    console.log('  "reef, show me a report for the last 30 days"');
    console.log('  "reef, rename Isaam to Personal"');
  }

  log.info('init complete', {
    hooks: !!result.hooks,
    mcp: result.mcp.status,
    scan: result.scan?.sessions ?? 0,
    autogrouped: result.autogroup?.created.length ?? 0,
  });

  return result;
}
