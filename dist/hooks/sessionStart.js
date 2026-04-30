import { basename, dirname } from 'node:path';
import { getDb } from '../db.js';
import { loadConfig, getGroupForProject, getGroupDisplayName } from '../groups.js';
import { readDecisions } from '../docs.js';
import { readDriftReport } from '../drift.js';
import { log } from '../log.js';
function projectFromTranscriptPath(p) {
    if (!p)
        return null;
    return basename(dirname(p));
}
function humanAgo(iso) {
    if (!iso)
        return 'unknown';
    const then = Date.parse(iso);
    if (Number.isNaN(then))
        return 'unknown';
    const deltaMs = Date.now() - then;
    const mins = Math.floor(deltaMs / 60_000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30)
        return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}
function formatTokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
export async function sessionStart(input) {
    const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
    const currentSessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const project = projectFromTranscriptPath(transcriptPath);
    if (!project) {
        log.info('session-start: no project detected, skipping card');
        return {};
    }
    let lastSession;
    let topTools = [];
    try {
        const db = getDb();
        const row = db
            .prepare(`SELECT session_id, project, started_at, ended_at, turn_count, tool_call_count,
                total_input_tokens, total_output_tokens, total_cache_read_tokens,
                primary_model
         FROM sessions
         WHERE project = ? AND session_id != ?
         ORDER BY ended_at DESC
         LIMIT 1`)
            .get(project, currentSessionId);
        lastSession = row;
        if (row) {
            topTools = db
                .prepare(`SELECT tool_name, COUNT(*) as c
           FROM tool_calls
           WHERE session_id = ?
           GROUP BY tool_name
           ORDER BY c DESC
           LIMIT 5`)
                .all(row.session_id);
        }
    }
    catch (e) {
        log.warn('session-start db query failed', { err: e.message });
    }
    const cfg = loadConfig();
    const group = getGroupForProject(cfg, project);
    const label = group
        ? (cfg.groups[group]?.company
            ? `${getGroupDisplayName(cfg, group)} (${cfg.groups[group].company})`
            : getGroupDisplayName(cfg, group))
        : project;
    const lines = [];
    lines.push(`[reef] Resume card — ${label}`);
    if (!lastSession) {
        lines.push('First session tracked for this project. Have at it.');
    }
    else {
        const tokens = (lastSession.total_input_tokens ?? 0) +
            (lastSession.total_output_tokens ?? 0);
        lines.push(`Last session ${humanAgo(lastSession.ended_at)} ` +
            `(${lastSession.turn_count} turns, ` +
            `${lastSession.tool_call_count} tool calls, ` +
            `${formatTokens(tokens)} tokens, ` +
            `model: ${lastSession.primary_model ?? 'n/a'})`);
        // Sanity hint: extreme turn counts often mean multiple sessions got merged
        // into a single transcript file (e.g. /resume across many starts).
        if (lastSession.turn_count > 1000) {
            lines.push(`(note: ${lastSession.turn_count} turns is unusually high — this may aggregate multiple resumed sessions in one transcript.)`);
        }
        if (topTools.length > 0) {
            const summary = topTools
                .map((t) => `${t.tool_name}×${t.c}`)
                .join(', ');
            lines.push(`Top tools last time: ${summary}`);
        }
    }
    if (group) {
        lines.push('Auto-log significant technical or architectural decisions using reef_log_decision (group: ' + group + ').');
        try {
            const drift = readDriftReport(group);
            if (drift && drift.totals.violations > 0) {
                const top = drift.results.find((r) => r.status === 'violation');
                const example = top ? `e.g. "${top.claim.description}" (${top.violations[0]?.file ?? '?'})` : '';
                lines.push(`⚠️  ${drift.totals.violations} drift violation(s) since last check${example ? ' — ' + example : ''}.`);
            }
        }
        catch (e) {
            log.warn('session-start: drift surface failed', { err: e.message });
        }
        // If the last session looks substantial AND no decision has been logged since
        // it started, nudge Claude to retro-log the key decisions before continuing.
        if (lastSession && (lastSession.tool_call_count >= 50 || lastSession.turn_count >= 30)) {
            try {
                const decisions = readDecisions(group);
                const sessionStartIso = lastSession.started_at ?? '';
                const loggedSinceLastSession = decisions.some((d) => {
                    const k = d.ts ?? d.date ?? '';
                    return sessionStartIso && k >= sessionStartIso;
                });
                if (!loggedSinceLastSession) {
                    lines.push(`Last session was substantial (${lastSession.turn_count} turns, ${lastSession.tool_call_count} tools) but no decisions were logged. ` +
                        `If any architectural decisions or pivots happened, retro-log them now via reef_log_decision before continuing.`);
                }
            }
            catch (e) {
                log.warn('session-start: decision suggester failed', { err: e.message });
            }
        }
    }
    return {
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: lines.join('\n'),
        },
    };
}
//# sourceMappingURL=sessionStart.js.map