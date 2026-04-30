import { log } from '../log.js';
/**
 * A command's first pipeline segment — the part before any `|`.
 * Used so rules only consider the process that actually runs first;
 * a command like `foo | tail -5` shouldn't trigger the Read nudge.
 */
function firstSegment(cmd) {
    const pipe = cmd.indexOf('|');
    return (pipe >= 0 ? cmd.slice(0, pipe) : cmd).trim();
}
function looksLikePath(tok) {
    if (tok.startsWith('-'))
        return false;
    if (tok.length < 2)
        return false;
    // Has a path separator, or looks like a filename with extension,
    // or is a dotfile (e.g. `.env`).
    return /[/\\]/.test(tok) || /\.[a-zA-Z0-9]+$/.test(tok) || /^\.[a-zA-Z]/.test(tok);
}
const RULES = [
    {
        name: 'grep',
        test: (cmd) => {
            // Only fire when grep/rg starts the pipeline. Piped use like
            // `cmd | grep "x"` filters another command's output and Grep tool can't help there.
            const seg = firstSegment(cmd);
            return /^(rg|grep)\b/.test(seg)
                ? 'Use the Grep tool instead of rg/grep — faster, structured results, no shell escaping.'
                : null;
        },
    },
    {
        name: 'find',
        test: (cmd) => {
            const seg = firstSegment(cmd);
            // Skip `find . -exec ...` style only when it's clearly the first thing.
            return /^find\b/.test(seg)
                ? 'Use the Glob tool instead of `find` — simpler and gitignore-aware.'
                : null;
        },
    },
    {
        name: 'sed',
        test: (cmd) => {
            // Only fire when sed is the first segment. Piped sed (`cmd | sed`) is filtering output, not editing files.
            const seg = firstSegment(cmd);
            return /^sed\b/.test(seg)
                ? 'Use the Edit tool for file edits — sed is brittle and cross-platform hostile.'
                : null;
        },
    },
    {
        name: 'cat-head-tail',
        test: (cmd) => {
            // Only fire for the FIRST pipeline segment — pagination on a pipe output is fine.
            const seg = firstSegment(cmd);
            const m = seg.match(/^(cat|head|tail)\b\s*(.*)$/);
            if (!m)
                return null;
            const args = (m[2] ?? '').trim();
            // Heredoc / process substitution is not a file read — skip.
            if (/^<<-?/.test(args))
                return null;
            // Stdin redirection (`tail < foo`) — unusual, skip to avoid noise.
            if (args.startsWith('<'))
                return null;
            // No args at all (`tail` reading stdin in a pipeline): skip.
            if (args.length === 0)
                return null;
            const tokens = args.split(/\s+/).filter((t) => t.length > 0);
            const nonFlagTokens = tokens.filter((t) => !t.startsWith('-'));
            // If every token is a flag (e.g. `tail -n 5` with no file), it's pagination.
            if (nonFlagTokens.length === 0)
                return null;
            // At least one token must look like a file path.
            if (!nonFlagTokens.some(looksLikePath))
                return null;
            return 'Use the Read tool for files — it handles offsets, truncation, and binary safely.';
        },
    },
];
export async function bashNudge(input) {
    if (input.tool_name !== 'Bash')
        return {};
    const cmd = input.tool_input?.command;
    if (typeof cmd !== 'string' || cmd.length === 0)
        return {};
    for (const rule of RULES) {
        const msg = rule.test(cmd);
        if (msg) {
            log.info('bash nudge fired', { rule: rule.name });
            return {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    additionalContext: `[reef] ${msg}`,
                },
            };
        }
    }
    return {};
}
//# sourceMappingURL=bashNudge.js.map