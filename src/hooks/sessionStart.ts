import { basename, dirname } from 'node:path';
import { getDb } from '../db.js';
import { loadConfig, getGroupForProject } from '../groups.js';
import { log } from '../log.js';

interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
}

interface LastSessionRow {
  session_id: string;
  project: string;
  ended_at: string | null;
  turn_count: number;
  tool_call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  primary_model: string | null;
}

function projectFromTranscriptPath(p: string): string | null {
  if (!p) return null;
  return basename(dirname(p));
}

function humanAgo(iso: string | null): string {
  if (!iso) return 'unknown';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const deltaMs = Date.now() - then;
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export async function sessionStart(
  input: SessionStartInput,
): Promise<unknown> {
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const currentSessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const project = projectFromTranscriptPath(transcriptPath);

  if (!project) {
    log.info('session-start: no project detected, skipping card');
    return {};
  }

  let lastSession: LastSessionRow | undefined;
  let topTools: Array<{ tool_name: string; c: number }> = [];
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT session_id, project, ended_at, turn_count, tool_call_count,
                total_input_tokens, total_output_tokens, total_cache_read_tokens,
                primary_model
         FROM sessions
         WHERE project = ? AND session_id != ?
         ORDER BY ended_at DESC
         LIMIT 1`,
      )
      .get(project, currentSessionId) as LastSessionRow | undefined;
    lastSession = row;

    if (row) {
      topTools = db
        .prepare(
          `SELECT tool_name, COUNT(*) as c
           FROM tool_calls
           WHERE session_id = ?
           GROUP BY tool_name
           ORDER BY c DESC
           LIMIT 5`,
        )
        .all(row.session_id) as Array<{ tool_name: string; c: number }>;
    }
  } catch (e) {
    log.warn('session-start db query failed', { err: (e as Error).message });
  }

  const cfg = loadConfig();
  const group = getGroupForProject(cfg, project);
  const label = group
    ? (cfg.groups[group]?.company
        ? `${group} (${cfg.groups[group]!.company})`
        : group)
    : project;

  const lines: string[] = [];
  lines.push(`[reef] Resume card — ${label}`);

  if (!lastSession) {
    lines.push('First session tracked for this project. Have at it.');
  } else {
    const tokens =
      (lastSession.total_input_tokens ?? 0) +
      (lastSession.total_output_tokens ?? 0);
    lines.push(
      `Last session ${humanAgo(lastSession.ended_at)} ` +
        `(${lastSession.turn_count} turns, ` +
        `${lastSession.tool_call_count} tool calls, ` +
        `${formatTokens(tokens)} tokens, ` +
        `model: ${lastSession.primary_model ?? 'n/a'})`,
    );
    if (topTools.length > 0) {
      const summary = topTools
        .map((t) => `${t.tool_name}×${t.c}`)
        .join(', ');
      lines.push(`Top tools last time: ${summary}`);
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };
}
