import { readFileSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { REEF_LOG_FILE } from './paths.js';
import { log } from './log.js';
const REPO_URL = 'https://github.com/IsaamMJ/cc-reef';
const MAX_LOG_LINES = 200;
const MAX_BODY_CHARS = 6000;
const REEF_VERSION = '0.0.1';
/**
 * Scrub anything that could leak the user's identity, clients, or paths.
 * Runs a series of conservative regex replacements. If in doubt, scrub.
 */
function sanitize(text) {
    if (!text)
        return text;
    const home = homedir();
    const userName = userInfo().username;
    let out = text;
    // Replace the literal home dir. Logs are JSON-stringified so backslashes
    // appear doubled ("C:\\Users\\..."); we try both forms plus the forward-
    // slash form for good measure.
    if (home) {
        const homeFwd = home.replace(/\\/g, '/');
        const homeDoubled = home.replace(/\\/g, '\\\\');
        out = out.split(home).join('~');
        out = out.split(homeFwd).join('~');
        out = out.split(homeDoubled).join('~');
    }
    // Scrub user-profile paths in any casing, with single OR doubled slashes.
    out = out.replace(/C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/"\s]+/gi, '~');
    out = out.replace(/\/Users\/[^/"\s]+/g, '~');
    out = out.replace(/\/home\/[^/"\s]+/g, '~');
    // Fallback: direct username scrub (catches anywhere the name appears,
    // even inside exotic path formats we didn't anticipate).
    if (userName && userName.length >= 3) {
        const pattern = new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        out = out.replace(pattern, '<user>');
    }
    // Scrub Claude's mangled project folder names (e.g. "E--ClientA-backend").
    out = out.replace(/\b[A-Z]--[A-Za-z0-9][\w-]*/g, '<project>');
    // Scrub session UUIDs.
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<session-id>');
    return out;
}
function readLastLines(path, n) {
    if (!existsSync(path))
        return '';
    try {
        const raw = readFileSync(path, 'utf8');
        const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
        return lines.slice(-n).join('\n');
    }
    catch {
        return '';
    }
}
function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            // `start` needs a cmd shell and an empty title arg first.
            spawn('cmd', ['/c', 'start', '""', url], {
                detached: true,
                stdio: 'ignore',
            }).unref();
        }
        else if (process.platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
        else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
    }
    catch (e) {
        log.warn('browser open failed', { err: e.message });
    }
}
export function reportBug(opts = {}) {
    const rawLog = readLastLines(REEF_LOG_FILE, MAX_LOG_LINES);
    const sanitized = sanitize(rawLog);
    const linesIncluded = sanitized ? sanitized.split('\n').length : 0;
    const envInfo = [
        `- reef version: ${REEF_VERSION}`,
        `- OS: ${process.platform} ${process.arch}`,
        `- Node: ${process.version}`,
    ].join('\n');
    let body = [
        `## What happened`,
        ``,
        `<!-- Describe what you were doing and what went wrong. -->`,
        ``,
        `## Expected vs actual`,
        ``,
        `<!-- What did you expect to see? What did you see instead? -->`,
        ``,
        `## Environment`,
        envInfo,
        ``,
        `## Recent log (auto-sanitised: paths, project names, and session IDs scrubbed)`,
        '```',
        sanitized || '(no log entries found)',
        '```',
        ``,
        `---`,
        `<sub>Filed via \`reef report-bug\`.</sub>`,
    ].join('\n');
    if (body.length > MAX_BODY_CHARS) {
        const keep = body.slice(0, MAX_BODY_CHARS - 80);
        body = keep + '\n... (log truncated — run `reef report-bug --print` for full output)';
    }
    const title = opts.title ?? '[bug] ';
    const url = `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    if (!opts.noOpen)
        openBrowser(url);
    log.info('report-bug', { bodyLength: body.length, opened: !opts.noOpen });
    return { url, bodyLength: body.length, logLinesIncluded: linesIncluded };
}
export function previewBugReport() {
    const rawLog = readLastLines(REEF_LOG_FILE, MAX_LOG_LINES);
    return sanitize(rawLog) || '(no log entries found)';
}
//# sourceMappingURL=reportBug.js.map