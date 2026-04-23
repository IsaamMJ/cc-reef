import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, } from 'node:fs';
import { REEF_LOGS, REEF_LOG_FILE } from './paths.js';
const MAX_LOG_BYTES = 10 * 1024 * 1024;
function ensureLogDir() {
    if (!existsSync(REEF_LOGS)) {
        mkdirSync(REEF_LOGS, { recursive: true });
    }
}
function rotateIfNeeded() {
    try {
        if (!existsSync(REEF_LOG_FILE))
            return;
        const size = statSync(REEF_LOG_FILE).size;
        if (size < MAX_LOG_BYTES)
            return;
        renameSync(REEF_LOG_FILE, `${REEF_LOG_FILE}.1`);
    }
    catch {
        // rotation failure must not break the running program.
    }
}
function write(level, msg, meta) {
    try {
        ensureLogDir();
        rotateIfNeeded();
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            level,
            msg,
            ...(meta ?? {}),
        });
        appendFileSync(REEF_LOG_FILE, line + '\n');
    }
    catch {
        // Logging must never throw — swallow I/O errors.
    }
}
export const log = {
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    debug: (msg, meta) => {
        if (process.env.REEF_DEBUG)
            write('debug', msg, meta);
    },
};
//# sourceMappingURL=log.js.map