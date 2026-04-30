import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REEF_HOME,
  CLAUDE_SETTINGS,
  CLAUDE_HOME,
} from './paths.js';
import { loadConfig, getGroupForProject, getGroupDisplayName } from './groups.js';
import { HookInstallError } from './errors.js';
import { log } from './log.js';

interface WrappedConfig {
  command?: string;
}

interface RawSettings {
  statusLine?: { type?: string; command?: string };
  [k: string]: unknown;
}

const WRAPPED_CONFIG_PATH = join(REEF_HOME, 'wrapped-statusline.json');
const REEF_STATUSLINE_MARKER = 'statusline run';

function defaultCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), 'cli.js');
}

function loadWrapped(): WrappedConfig {
  if (!existsSync(WRAPPED_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(WRAPPED_CONFIG_PATH, 'utf8')) as WrappedConfig;
  } catch {
    return {};
  }
}

function saveWrapped(cfg: WrappedConfig): void {
  if (!existsSync(REEF_HOME)) mkdirSync(REEF_HOME, { recursive: true });
  writeFileSync(WRAPPED_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function projectFromInput(input: Record<string, unknown>): string | null {
  const tp = input.transcript_path;
  if (typeof tp === 'string' && tp.length > 0) {
    return basename(dirname(tp));
  }
  // Fallback: convert cwd into Claude's mangled folder form ("E:\foo\bar" -> "E--foo-bar")
  const cwd = input.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    return cwd
      .replace(/\\/g, '-')
      .replace(/\//g, '-')
      .replace(/:/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
  return null;
}

function buildReefSegment(project: string | null): string {
  if (!project) return '🪸';
  try {
    const cfg = loadConfig();
    const group = getGroupForProject(cfg, project);
    if (!group) return `🪸 ${project} · ungrouped`;
    const company = cfg.groups[group]?.company;
    const displayName = getGroupDisplayName(cfg, group);
    if (company && company !== displayName) {
      return `🪸 ${company} · ${displayName}`;
    }
    return `🪸 ${displayName}`;
  } catch (e) {
    log.warn('statusline config read failed', { err: (e as Error).message });
    return `🪸 ${project}`;
  }
}

function runWrappedCommand(cmd: string, stdinData: string): string {
  const r = spawnSync(cmd, [], {
    input: stdinData,
    shell: true,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trimEnd();
  log.warn('wrapped statusline failed', {
    code: r.status,
    err: (r.stderr ?? '').slice(0, 200),
  });
  return '';
}

export async function runStatusline(): Promise<void> {
  const stdinData = await readStdin();
  let input: Record<string, unknown> = {};
  try {
    if (stdinData.trim()) input = JSON.parse(stdinData);
  } catch {
    // keep empty — the reef segment still works from cwd
  }

  const project = projectFromInput(input);
  const reefSegment = buildReefSegment(project);

  const wrapped = loadWrapped();
  let left = '';
  if (wrapped.command) {
    left = runWrappedCommand(wrapped.command, stdinData);
  }

  // Use stdout directly with no trailing newline — CC renders status line as-is.
  process.stdout.write(left ? `${left}  ${reefSegment}` : reefSegment);
}

// -------- install / uninstall --------

function loadSettings(): RawSettings {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  try {
    const raw = readFileSync(CLAUDE_SETTINGS, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as RawSettings) : {};
  } catch (e) {
    throw new HookInstallError(
      `cannot parse ${CLAUDE_SETTINGS}: ${(e as Error).message}`,
      CLAUDE_SETTINGS,
    );
  }
}

function saveSettings(settings: RawSettings): void {
  if (!existsSync(CLAUDE_HOME)) mkdirSync(CLAUDE_HOME, { recursive: true });
  const tmp = CLAUDE_SETTINGS + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, CLAUDE_SETTINGS);
}

function backupSettings(): string | null {
  if (!existsSync(CLAUDE_SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${CLAUDE_SETTINGS}.reef-statusline-backup-${stamp}`;
  copyFileSync(CLAUDE_SETTINGS, backup);
  return backup;
}

export interface InstallStatuslineResult {
  previousCommand: string | null;
  newCommand: string;
  settingsPath: string;
  backupPath: string | null;
  action: 'installed' | 'already';
}

export function installStatusline(opts: { cliPath?: string } = {}): InstallStatuslineResult {
  const cliPath = opts.cliPath ?? defaultCliPath();
  const newCommand = `node "${cliPath}" statusline run`;

  const settings = loadSettings();
  const prev = settings.statusLine?.command ?? null;

  // If already wrapped, don't re-wrap (would lose the original command).
  if (prev && prev.includes(REEF_STATUSLINE_MARKER)) {
    return {
      previousCommand: loadWrapped().command ?? null,
      newCommand: prev,
      settingsPath: CLAUDE_SETTINGS,
      backupPath: null,
      action: 'already',
    };
  }

  const backupPath = backupSettings();

  // Remember the user's original so our wrapper can delegate to it.
  if (prev) saveWrapped({ command: prev });
  else saveWrapped({});

  settings.statusLine = { type: 'command', command: newCommand };
  saveSettings(settings);
  log.info('statusline installed', { previous: !!prev });

  return {
    previousCommand: prev,
    newCommand,
    settingsPath: CLAUDE_SETTINGS,
    backupPath,
    action: 'installed',
  };
}

export interface UninstallStatuslineResult {
  restored: string | null;
  settingsPath: string;
  backupPath: string | null;
}

export function uninstallStatusline(): UninstallStatuslineResult {
  const settings = loadSettings();
  const wrapped = loadWrapped();
  const backupPath = backupSettings();

  if (wrapped.command) {
    settings.statusLine = { type: 'command', command: wrapped.command };
  } else if (settings.statusLine?.command?.includes(REEF_STATUSLINE_MARKER)) {
    delete settings.statusLine;
  }
  saveSettings(settings);
  log.info('statusline uninstalled', { restored: !!wrapped.command });

  return {
    restored: wrapped.command ?? null,
    settingsPath: CLAUDE_SETTINGS,
    backupPath,
  };
}
