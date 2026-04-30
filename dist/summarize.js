import { existsSync, readFileSync } from 'node:fs';
import { getDb } from './db.js';
import { chat, nimAvailable } from './nim.js';
import { log } from './log.js';
function extractText(line) {
    try {
        const obj = JSON.parse(line);
        if (!obj.message)
            return null;
        const role = obj.message.role ?? obj.type ?? '';
        let text = '';
        const c = obj.message.content;
        if (typeof c === 'string')
            text = c;
        else if (Array.isArray(c)) {
            for (const item of c) {
                if (typeof item === 'object' && item !== null) {
                    const it = item;
                    if (it.type === 'text' && typeof it.text === 'string')
                        text += it.text + '\n';
                    else if (it.type === 'tool_use' && it.name)
                        text += `[tool: ${it.name}]\n`;
                }
            }
        }
        text = text.trim();
        if (!text)
            return null;
        return { role, text };
    }
    catch {
        return null;
    }
}
function buildPrompt(s, firstUser, lastAssistant) {
    return [
        `Project: ${s.project}`,
        `Turns: ${s.turn_count} · Tool calls: ${s.tool_call_count} · Model: ${s.primary_model ?? 'unknown'}`,
        ``,
        `FIRST USER MESSAGE:`,
        firstUser.slice(0, 1500),
        ``,
        `LAST ASSISTANT MESSAGE:`,
        lastAssistant.slice(0, 1500),
    ].join('\n');
}
export async function summarizeSession(sessionId, force = false) {
    if (!nimAvailable())
        throw new Error('NIM_API_KEY not set');
    const db = getDb();
    const row = db.prepare(`SELECT session_id, source_file, project, turn_count, tool_call_count, primary_model, summary
     FROM sessions WHERE session_id = ?`).get(sessionId);
    if (!row)
        return null;
    if (row.summary && !force)
        return row.summary;
    if (!existsSync(row.source_file)) {
        log.warn('summarize skipped — file missing', { file: row.source_file });
        return null;
    }
    const raw = readFileSync(row.source_file, 'utf8').split('\n').filter(Boolean);
    let firstUser = '';
    let lastAssistant = '';
    for (const line of raw) {
        const p = extractText(line);
        if (!p)
            continue;
        if (!firstUser && (p.role === 'user' || p.role === 'human'))
            firstUser = p.text;
        if (p.role === 'assistant')
            lastAssistant = p.text;
    }
    if (!firstUser && !lastAssistant)
        return null;
    const summary = await chat([
        {
            role: 'system',
            content: 'You write one-line session summaries for a developer activity dashboard. ' +
                'Output ONE sentence, max 18 words, past tense, concrete. ' +
                'Format: "Did X; outcome." Examples: "Refactored auth middleware; tests passed." ' +
                '"Debugged Stripe webhook 500s; root cause was missing signature header." ' +
                'No filler, no preamble, no quotes. If you cannot tell, say "Brief exchange — purpose unclear."',
        },
        { role: 'user', content: buildPrompt(row, firstUser, lastAssistant) },
    ], { maxTokens: 80 });
    const cleaned = summary.replace(/^["']|["']$/g, '').replace(/\n+/g, ' ').trim().slice(0, 200);
    db.prepare(`UPDATE sessions SET summary = ?, summary_at = ? WHERE session_id = ?`)
        .run(cleaned, new Date().toISOString(), sessionId);
    return cleaned;
}
export async function summarizeRecent(limit = 20, force = false) {
    if (!nimAvailable())
        throw new Error('NIM_API_KEY not set');
    const db = getDb();
    const rows = db.prepare(`SELECT session_id FROM sessions
     WHERE ended_at IS NOT NULL ${force ? '' : 'AND (summary IS NULL OR summary = "")'}
     ORDER BY ended_at DESC LIMIT ?`).all(limit);
    let done = 0, failed = 0, skipped = 0;
    for (const r of rows) {
        try {
            const out = await summarizeSession(r.session_id, force);
            if (out)
                done++;
            else
                skipped++;
        }
        catch (e) {
            log.error('summarize failed', { sid: r.session_id, err: e.message });
            failed++;
        }
    }
    return { done, failed, skipped };
}
export async function aiOverviewLine(days) {
    if (!nimAvailable())
        return null;
    const db = getDb();
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`SELECT s.summary, s.project, s.ended_at FROM sessions s
     WHERE s.ended_at IS NOT NULL AND s.ended_at >= ? AND s.summary IS NOT NULL AND s.summary != ""
     ORDER BY s.ended_at DESC LIMIT 30`).all(since);
    if (rows.length === 0)
        return null;
    const list = rows.map((r) => `- (${r.project}) ${r.summary}`).join('\n');
    try {
        return await chat([
            {
                role: 'system',
                content: 'You write a 2-sentence weekly recap for a developer dashboard. ' +
                    'Read the session summaries and synthesize: what was the main thread of work, what was the pattern. ' +
                    'Be concrete and specific to projects mentioned. No filler. Past tense.',
            },
            { role: 'user', content: `Last ${days} days of session summaries:\n\n${list}` },
        ], { maxTokens: 120 });
    }
    catch (e) {
        log.error('ai overview line failed', { err: e.message });
        return null;
    }
}
//# sourceMappingURL=summarize.js.map