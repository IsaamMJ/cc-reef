import { sessionStart } from './sessionStart.js';
import { bashNudge } from './bashNudge.js';
import { postSession } from './postSession.js';
import { driftWatch } from './driftWatch.js';
import { autoReport } from '../autoReport.js';
import { log } from '../log.js';
import { formatError } from '../formatError.js';
/**
 * Hook dispatcher. Reads a JSON payload from stdin, routes to the named
 * handler, writes JSON to stdout. Never throws or exits non-zero on
 * internal errors — a broken hook must not break the user's CC session.
 */
export async function runHook(name) {
    const raw = await readStdin();
    let input;
    try {
        input = raw.trim() ? JSON.parse(raw) : {};
    }
    catch (e) {
        log.warn('hook stdin parse failed', { hook: name, err: e.message });
        process.stdout.write('{}');
        return;
    }
    try {
        let out;
        switch (name) {
            case 'session-start':
                out = await sessionStart(input);
                break;
            case 'bash-nudge':
                out = await bashNudge(input);
                break;
            case 'post-session':
                out = await postSession(input);
                break;
            case 'drift-watch':
                out = await driftWatch(input);
                break;
            default:
                log.warn('unknown hook', { name });
                out = {};
        }
        process.stdout.write(JSON.stringify(out ?? {}));
    }
    catch (e) {
        log.error('hook handler threw', { hook: name, err: formatError(e) });
        // Swallow — never block CC on our bug. Also fire-and-forget an auto-report
        // (no await; we can't slow the hook return down).
        autoReport({
            source: `hook:${name}`,
            message: e.message ?? String(e),
            stack: e.stack,
        }).catch(() => { });
        process.stdout.write('{}');
    }
}
function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) {
            resolve('');
            return;
        }
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });
}
//# sourceMappingURL=runner.js.map