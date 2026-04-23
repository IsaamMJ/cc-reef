import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDb, closeDb } from './db.js';
import { loadConfig, getGroupForProject, UNGROUPED } from './groups.js';
import { log } from './log.js';
function fmtTokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
function fmtPct(part, whole) {
    if (whole === 0)
        return '0%';
    return `${((part / whole) * 100).toFixed(1)}%`;
}
function sinceIso(opts) {
    if (opts.since)
        return opts.since;
    const days = opts.days ?? 7;
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return d.toISOString();
}
export function generateReport(opts = {}) {
    const since = sinceIso(opts);
    const cfg = loadConfig();
    const db = getDb();
    // All sessions in window.
    const sessions = db
        .prepare(`SELECT session_id, project, started_at, ended_at, turn_count, tool_call_count,
              total_input_tokens, total_output_tokens, total_cache_read_tokens, primary_model
       FROM sessions
       WHERE ended_at IS NOT NULL AND ended_at >= ?`)
        .all(since);
    if (sessions.length === 0) {
        closeDb();
        return [
            `# reef report`,
            ``,
            `No sessions found since **${since}**.`,
            ``,
            `Try a wider window: \`reef report --days 30\``,
            ``,
        ].join('\n');
    }
    // Aggregate per group.
    const groups = new Map();
    for (const s of sessions) {
        const groupName = getGroupForProject(cfg, s.project) ?? UNGROUPED;
        const company = groupName === UNGROUPED
            ? null
            : cfg.groups[groupName]?.company ?? null;
        let row = groups.get(groupName);
        if (!row) {
            row = {
                group: groupName,
                company,
                projects: [],
                sessions: 0,
                turns: 0,
                toolCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                primaryModel: null,
                topTools: [],
            };
            groups.set(groupName, row);
        }
        if (!row.projects.includes(s.project))
            row.projects.push(s.project);
        row.sessions++;
        row.turns += s.turn_count;
        row.toolCalls += s.tool_call_count;
        row.inputTokens += s.total_input_tokens;
        row.outputTokens += s.total_output_tokens;
        row.cacheReadTokens += s.total_cache_read_tokens;
        if (!row.primaryModel && s.primary_model)
            row.primaryModel = s.primary_model;
    }
    // Per-group top tools (one query per group, with session IDs bound).
    for (const row of groups.values()) {
        const sessionIds = sessions
            .filter((s) => row.projects.includes(s.project))
            .map((s) => s.session_id);
        if (sessionIds.length === 0)
            continue;
        const placeholders = sessionIds.map(() => '?').join(',');
        const rows = db
            .prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls
         WHERE session_id IN (${placeholders})
         GROUP BY tool_name ORDER BY c DESC LIMIT 5`)
            .all(...sessionIds);
        row.topTools = rows.map((r) => ({ tool: r.tool_name, count: r.c }));
    }
    // Totals.
    const totalSessions = sessions.length;
    const totalTurns = sessions.reduce((a, s) => a + s.turn_count, 0);
    const totalToolCalls = sessions.reduce((a, s) => a + s.tool_call_count, 0);
    const totalInput = sessions.reduce((a, s) => a + s.total_input_tokens, 0);
    const totalOutput = sessions.reduce((a, s) => a + s.total_output_tokens, 0);
    // Global tool usage across window.
    const sessionIds = sessions.map((s) => s.session_id);
    const placeholders = sessionIds.map(() => '?').join(',');
    const toolRows = db
        .prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls
       WHERE session_id IN (${placeholders})
       GROUP BY tool_name ORDER BY c DESC`)
        .all(...sessionIds);
    // Model distribution.
    const modelRows = db
        .prepare(`SELECT primary_model, COUNT(*) c FROM sessions
       WHERE ended_at IS NOT NULL AND ended_at >= ? AND primary_model IS NOT NULL
       GROUP BY primary_model ORDER BY c DESC`)
        .all(since);
    closeDb();
    // Bash vs native.
    const toolMap = new Map(toolRows.map((r) => [r.tool_name, r.c]));
    const bash = toolMap.get('Bash') ?? 0;
    const grep = toolMap.get('Grep') ?? 0;
    const glob = toolMap.get('Glob') ?? 0;
    const read = toolMap.get('Read') ?? 0;
    const native = grep + glob + read;
    const ratio = native === 0 ? Infinity : bash / native;
    // Build markdown.
    const lines = [];
    lines.push(`# reef report`);
    lines.push('');
    lines.push(`**Window:** since ${since}`);
    lines.push('');
    lines.push(`## Overview`);
    lines.push('');
    lines.push(`- Sessions: **${totalSessions}**`);
    lines.push(`- Turns: **${totalTurns.toLocaleString()}**`);
    lines.push(`- Tool calls: **${totalToolCalls.toLocaleString()}**`);
    lines.push(`- Tokens in / out: **${fmtTokens(totalInput)}** / **${fmtTokens(totalOutput)}**`);
    lines.push('');
    lines.push(`## By group`);
    lines.push('');
    const sortedGroups = [...groups.values()].sort((a, b) => b.sessions - a.sessions);
    for (const row of sortedGroups) {
        const title = row.company ? `${row.group} (${row.company})` : row.group;
        lines.push(`### ${title}`);
        lines.push('');
        lines.push(`- Sessions: **${row.sessions}** · Turns: **${row.turns.toLocaleString()}** · ` +
            `Tool calls: **${row.toolCalls.toLocaleString()}** · ` +
            `Tokens: **${fmtTokens(row.inputTokens + row.outputTokens)}**`);
        if (row.primaryModel)
            lines.push(`- Primary model: \`${row.primaryModel}\``);
        if (row.projects.length > 1) {
            lines.push(`- Folders: ${row.projects.map((p) => `\`${p}\``).join(', ')}`);
        }
        if (row.topTools.length > 0) {
            const tools = row.topTools
                .map((t) => `${t.tool}×${t.count}`)
                .join(', ');
            lines.push(`- Top tools: ${tools}`);
        }
        lines.push('');
    }
    lines.push(`## Top tools (all projects)`);
    lines.push('');
    lines.push(`| Tool | Count | Share |`);
    lines.push(`|------|------:|------:|`);
    for (const r of toolRows.slice(0, 10)) {
        lines.push(`| ${r.tool_name} | ${r.c.toLocaleString()} | ${fmtPct(r.c, totalToolCalls)} |`);
    }
    lines.push('');
    lines.push(`## Model usage`);
    lines.push('');
    for (const r of modelRows) {
        lines.push(`- \`${r.primary_model}\`: ${r.c} sessions (${fmtPct(r.c, totalSessions)})`);
    }
    lines.push('');
    lines.push(`## Bash vs native tools`);
    lines.push('');
    lines.push(`- Bash: **${bash.toLocaleString()}**`);
    lines.push(`- Grep + Glob + Read: **${native.toLocaleString()}**`);
    lines.push(`- Bash / native ratio: **${Number.isFinite(ratio) ? ratio.toFixed(2) : '∞'}** ` +
        `${ratio < 0.5 ? '✓ healthy' : ratio < 1 ? '~ ok' : '⚠ high — consider Grep/Glob/Read more'}`);
    lines.push('');
    // Simple insights.
    lines.push(`## Quick wins`);
    lines.push('');
    const insights = [];
    if (ratio >= 1) {
        insights.push(`Bash is used more than native search/read tools — the PreToolUse hook should help reduce this over time.`);
    }
    const opusSessions = modelRows.find((r) => r.primary_model.includes('opus'))?.c ?? 0;
    const haikuSessions = modelRows.find((r) => r.primary_model.includes('haiku'))?.c ?? 0;
    if (opusSessions > haikuSessions * 2 && opusSessions > 10) {
        insights.push(`Opus is dominant (${opusSessions} vs ${haikuSessions} Haiku sessions). Consider Haiku for short, tool-light tasks.`);
    }
    const ungrouped = groups.get(UNGROUPED);
    if (ungrouped && ungrouped.projects.length > 0) {
        insights.push(`${ungrouped.projects.length} project folder(s) are ungrouped — run \`reef groups\` to label them.`);
    }
    if (insights.length === 0)
        insights.push(`Nothing surfacing — your patterns look clean this window.`);
    for (const i of insights)
        lines.push(`- ${i}`);
    lines.push('');
    const out = lines.join('\n');
    log.info('report generated', { sessions: totalSessions, groups: groups.size });
    return out;
}
export function writeReport(opts = {}) {
    const content = generateReport(opts);
    if (!opts.outFile)
        return { content, outFile: null };
    const dir = dirname(opts.outFile);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(opts.outFile, content, 'utf8');
    return { content, outFile: opts.outFile };
}
//# sourceMappingURL=report.js.map