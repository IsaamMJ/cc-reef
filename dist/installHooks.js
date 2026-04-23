import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { CLAUDE_SETTINGS, CLAUDE_HOME } from './paths.js';
import { HookInstallError } from './errors.js';
import { log } from './log.js';
const HOOK_SPEC = [
    { event: 'SessionStart', hookName: 'session-start', matcher: undefined },
    { event: 'PreToolUse', hookName: 'bash-nudge', matcher: 'Bash' },
    { event: 'Stop', hookName: 'post-session', matcher: undefined },
];
function loadSettings() {
    if (!existsSync(CLAUDE_SETTINGS))
        return {};
    try {
        const raw = readFileSync(CLAUDE_SETTINGS, 'utf8');
        return raw.trim() ? JSON.parse(raw) : {};
    }
    catch (e) {
        throw new HookInstallError(`Cannot parse ${CLAUDE_SETTINGS}: ${e.message}`, CLAUDE_SETTINGS);
    }
}
function saveSettings(s) {
    if (!existsSync(CLAUDE_HOME))
        mkdirSync(CLAUDE_HOME, { recursive: true });
    const tmp = CLAUDE_SETTINGS + '.tmp';
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
    renameSync(tmp, CLAUDE_SETTINGS);
}
function backupSettings() {
    if (!existsSync(CLAUDE_SETTINGS))
        return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${CLAUDE_SETTINGS}.reef-backup-${stamp}`;
    copyFileSync(CLAUDE_SETTINGS, backup);
    return backup;
}
function defaultCliPath() {
    // Resolve to dist/cli.js alongside this compiled module.
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), 'cli.js');
}
function buildCommand(cliPath, hookName) {
    // Quote path for Windows paths that may contain spaces.
    return `node "${cliPath}" hook ${hookName}`;
}
function isOurHook(command, hookName) {
    return command.includes(` hook ${hookName}`);
}
export function installHooks(opts = {}) {
    const cliPath = opts.cliPath ?? defaultCliPath();
    if (!existsSync(cliPath)) {
        throw new HookInstallError(`CLI not found at ${cliPath}. Run "npm run build" first, or pass --cli-path.`, cliPath);
    }
    const backupPath = opts.dryRun ? null : backupSettings();
    const settings = loadSettings();
    settings.hooks ??= {};
    const commands = [];
    let added = 0;
    let updated = 0;
    for (const spec of HOOK_SPEC) {
        const command = buildCommand(cliPath, spec.hookName);
        commands.push({ event: spec.event, command });
        const events = (settings.hooks[spec.event] ??= []);
        const idx = events.findIndex((e) => e.matcher === spec.matcher &&
            e.hooks.some((h) => isOurHook(h.command, spec.hookName)));
        if (idx >= 0) {
            const entry = events[idx];
            entry.hooks = entry.hooks.map((h) => isOurHook(h.command, spec.hookName)
                ? { type: 'command', command }
                : h);
            updated++;
        }
        else {
            const entry = {
                ...(spec.matcher ? { matcher: spec.matcher } : {}),
                hooks: [{ type: 'command', command }],
            };
            events.push(entry);
            added++;
        }
    }
    if (!opts.dryRun)
        saveSettings(settings);
    log.info('install-hooks', { added, updated, dryRun: !!opts.dryRun });
    return {
        added,
        updated,
        settingsPath: CLAUDE_SETTINGS,
        backupPath,
        commands,
    };
}
export function uninstallHooks() {
    const backupPath = backupSettings();
    const settings = loadSettings();
    if (!settings.hooks)
        return { removed: 0, backupPath };
    let removed = 0;
    for (const [eventName, entries] of Object.entries(settings.hooks)) {
        const filtered = [];
        for (const entry of entries) {
            const keptHooks = entry.hooks.filter((h) => !HOOK_SPEC.some((s) => isOurHook(h.command, s.hookName)));
            if (keptHooks.length === entry.hooks.length) {
                filtered.push(entry);
            }
            else if (keptHooks.length > 0) {
                filtered.push({ ...entry, hooks: keptHooks });
                removed += entry.hooks.length - keptHooks.length;
            }
            else {
                removed += entry.hooks.length;
            }
        }
        if (filtered.length > 0)
            settings.hooks[eventName] = filtered;
        else
            delete settings.hooks[eventName];
    }
    saveSettings(settings);
    return { removed, backupPath };
}
//# sourceMappingURL=installHooks.js.map