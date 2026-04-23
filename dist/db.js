import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { REEF_DB } from './paths.js';
import { DBError } from './errors.js';
import { log } from './log.js';
let _db = null;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id                   TEXT PRIMARY KEY,
  project                      TEXT NOT NULL,
  source_file                  TEXT NOT NULL,
  file_mtime                   INTEGER NOT NULL,
  started_at                   TEXT,
  ended_at                     TEXT,
  turn_count                   INTEGER NOT NULL DEFAULT 0,
  tool_call_count              INTEGER NOT NULL DEFAULT 0,
  total_input_tokens           INTEGER NOT NULL DEFAULT 0,
  total_output_tokens          INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  primary_model                TEXT,
  parse_errors                 INTEGER NOT NULL DEFAULT 0,
  scanned_at                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id    TEXT NOT NULL,
  project       TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  model         TEXT,
  ts            TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_project ON tool_calls(project);
`;
export function getDb() {
    if (_db)
        return _db;
    try {
        const dir = dirname(REEF_DB);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        _db = new DatabaseSync(REEF_DB);
        _db.exec('PRAGMA journal_mode = WAL;');
        _db.exec('PRAGMA foreign_keys = ON;');
        _db.exec(SCHEMA);
        log.info('db opened', { path: REEF_DB });
        return _db;
    }
    catch (e) {
        throw new DBError(`Failed to open database at ${REEF_DB}: ${e.message}`);
    }
}
export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}
//# sourceMappingURL=db.js.map