import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { CLAUDE_PROJECTS } from './paths.js';
import { getDb } from './db.js';
import { parseJsonl, extractToolNames, type RawEvent } from './parser.js';
import { isParseError } from './errors.js';
import { log } from './log.js';

export interface ScanSummary {
  projects: number;
  filesScanned: number;
  filesSkipped: number;
  sessionsUpserted: number;
  toolCallsInserted: number;
  parseErrors: number;
  durationMs: number;
}

interface SessionAggregate {
  session_id: string;
  project: string;
  source_file: string;
  file_mtime: number;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number;
  tool_call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  primary_model: string | null;
  parse_errors: number;
  tool_events: Array<{ tool: string; model: string | null; ts: string | null }>;
}

function collectJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    log.warn('readdir failed', { dir, err: (e as Error).message });
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonl(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function aggregateFromEvent(agg: SessionAggregate, event: RawEvent): void {
  const ts =
    typeof event.timestamp === 'string' ? event.timestamp : null;
  if (ts) {
    if (!agg.started_at || ts < agg.started_at) agg.started_at = ts;
    if (!agg.ended_at || ts > agg.ended_at) agg.ended_at = ts;
  }

  if (event.type !== 'assistant') return;

  agg.turn_count++;

  const model = event.message?.model ?? null;
  if (model && !agg.primary_model) agg.primary_model = model;

  const usage = event.message?.usage;
  if (usage) {
    agg.total_input_tokens += usage.input_tokens ?? 0;
    agg.total_output_tokens += usage.output_tokens ?? 0;
    agg.total_cache_read_tokens += usage.cache_read_input_tokens ?? 0;
    agg.total_cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
  }

  const tools = extractToolNames(event);
  for (const tool of tools) {
    agg.tool_call_count++;
    agg.tool_events.push({ tool, model, ts });
  }
}

async function scanFile(
  filePath: string,
  project: string,
  fileMtime: number,
): Promise<SessionAggregate> {
  const sessionId = basename(filePath, extname(filePath));
  const agg: SessionAggregate = {
    session_id: sessionId,
    project,
    source_file: filePath,
    file_mtime: fileMtime,
    started_at: null,
    ended_at: null,
    turn_count: 0,
    tool_call_count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    primary_model: null,
    parse_errors: 0,
    tool_events: [],
  };

  try {
    for await (const { event } of parseJsonl(filePath)) {
      aggregateFromEvent(agg, event);
    }
  } catch (e) {
    if (isParseError(e)) {
      // One bad line shouldn't halt the scan — log and keep the partial aggregate.
      agg.parse_errors++;
      log.warn('parse error (partial session kept)', {
        file: filePath,
        line: e.lineNumber,
        err: e.message,
      });
    } else {
      throw e;
    }
  }

  return agg;
}

export async function scan(options: { force?: boolean } = {}): Promise<ScanSummary> {
  const start = Date.now();
  const db = getDb();
  const scannedAt = new Date().toISOString();

  const summary: ScanSummary = {
    projects: 0,
    filesScanned: 0,
    filesSkipped: 0,
    sessionsUpserted: 0,
    toolCallsInserted: 0,
    parseErrors: 0,
    durationMs: 0,
  };

  if (!existsSync(CLAUDE_PROJECTS)) {
    log.warn('no claude projects dir', { path: CLAUDE_PROJECTS });
    summary.durationMs = Date.now() - start;
    return summary;
  }

  const projectDirs = readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  summary.projects = projectDirs.length;

  const getExisting = db.prepare(
    'SELECT file_mtime FROM sessions WHERE session_id = ?',
  );
  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, project, source_file, file_mtime,
      started_at, ended_at, turn_count, tool_call_count,
      total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_creation_tokens,
      primary_model, parse_errors, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project = excluded.project,
      source_file = excluded.source_file,
      file_mtime = excluded.file_mtime,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      turn_count = excluded.turn_count,
      tool_call_count = excluded.tool_call_count,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_creation_tokens = excluded.total_cache_creation_tokens,
      primary_model = excluded.primary_model,
      parse_errors = excluded.parse_errors,
      scanned_at = excluded.scanned_at
  `);
  const deleteToolCalls = db.prepare(
    'DELETE FROM tool_calls WHERE session_id = ?',
  );
  const insertToolCall = db.prepare(
    'INSERT INTO tool_calls (session_id, project, tool_name, model, ts) VALUES (?, ?, ?, ?, ?)',
  );

  for (const project of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS, project);
    const files = collectJsonl(projectPath);

    for (const file of files) {
      const mtime = Math.floor(statSync(file).mtimeMs);
      const sessionId = basename(file, extname(file));

      if (!options.force) {
        const existing = getExisting.get(sessionId) as
          | { file_mtime: number }
          | undefined;
        if (existing && existing.file_mtime === mtime) {
          summary.filesSkipped++;
          continue;
        }
      }

      const agg = await scanFile(file, project, mtime);
      summary.parseErrors += agg.parse_errors;

      // Use a transaction so a session's stats and its tool_calls stay consistent.
      db.exec('BEGIN');
      try {
        upsertSession.run(
          agg.session_id,
          agg.project,
          agg.source_file,
          agg.file_mtime,
          agg.started_at,
          agg.ended_at,
          agg.turn_count,
          agg.tool_call_count,
          agg.total_input_tokens,
          agg.total_output_tokens,
          agg.total_cache_read_tokens,
          agg.total_cache_creation_tokens,
          agg.primary_model,
          agg.parse_errors,
          scannedAt,
        );
        // Replace tool_calls for this session rather than appending, so re-scans
        // of a grown file don't double-count events already stored.
        deleteToolCalls.run(agg.session_id);
        for (const tc of agg.tool_events) {
          insertToolCall.run(
            agg.session_id,
            agg.project,
            tc.tool,
            tc.model,
            tc.ts,
          );
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      summary.filesScanned++;
      summary.sessionsUpserted++;
      summary.toolCallsInserted += agg.tool_events.length;
    }
  }

  summary.durationMs = Date.now() - start;
  log.info('scan complete', { ...summary });
  return summary;
}
