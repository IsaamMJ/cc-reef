import {
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from 'node:fs';
import { REEF_LOGS, REEF_LOG_FILE } from './paths.js';

type Level = 'info' | 'warn' | 'error' | 'debug';

const MAX_LOG_BYTES = 10 * 1024 * 1024;

function ensureLogDir(): void {
  if (!existsSync(REEF_LOGS)) {
    mkdirSync(REEF_LOGS, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(REEF_LOG_FILE)) return;
    const size = statSync(REEF_LOG_FILE).size;
    if (size < MAX_LOG_BYTES) return;
    renameSync(REEF_LOG_FILE, `${REEF_LOG_FILE}.1`);
  } catch {
    // rotation failure must not break the running program.
  }
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
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
  } catch {
    // Logging must never throw — swallow I/O errors.
  }
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.REEF_DEBUG) write('debug', msg, meta);
  },
};
