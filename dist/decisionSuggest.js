import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { chat, llmAvailable } from './llm.js';
import { parseJsonl, isParseFailure, extractToolNames } from './parser.js';
import { log } from './log.js';
function pendingPath(group) {
    return join(REEF_KNOWLEDGE, group.toLowerCase(), 'pending-decisions.json');
}
export function readPendingDecisions(group) {
    const p = pendingPath(group);
    if (!existsSync(p))
        return [];
    try {
        const f = JSON.parse(readFileSync(p, 'utf8'));
        return f.decisions ?? [];
    }
    catch {
        return [];
    }
}
function writePending(group, decisions) {
    const p = pendingPath(group);
    const dir = dirname(p);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ decisions }, null, 2), 'utf8');
}
export function setPendingStatus(group, id, status) {
    const all = readPendingDecisions(group);
    const found = all.find((d) => d.id === id);
    if (!found)
        return null;
    found.status = status;
    writePending(group, all);
    return found;
}
export function clearProcessedPending(group) {
    const all = readPendingDecisions(group).filter((d) => d.status === 'pending');
    writePending(group, all);
}
function isContentBlock(x) {
    return typeof x === 'object' && x !== null;
}
async function summariseSession(transcriptPath) {
    const summary = {
        toolCounts: {},
        editedFiles: new Set(),
        bashCommands: [],
        totalAssistantTurns: 0,
        truncatedUserGoals: [],
    };
    for await (const yielded of parseJsonl(transcriptPath)) {
        if (isParseFailure(yielded))
            continue;
        const ev = yielded.event;
        const role = ev.type;
        const content = ev.message?.content;
        if (role === 'assistant') {
            summary.totalAssistantTurns++;
            for (const tool of extractToolNames(ev)) {
                summary.toolCounts[tool] = (summary.toolCounts[tool] ?? 0) + 1;
            }
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!isContentBlock(block) || block.type !== 'tool_use')
                        continue;
                    const toolName = block.name ?? '';
                    const input = block.input ?? {};
                    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') && typeof input.file_path === 'string') {
                        summary.editedFiles.add(input.file_path);
                    }
                    if (toolName === 'Bash' && typeof input.command === 'string') {
                        const cmd = input.command;
                        if (cmd.length < 200)
                            summary.bashCommands.push(cmd);
                    }
                }
            }
        }
        if (role === 'user' && Array.isArray(content)) {
            for (const block of content) {
                if (!isContentBlock(block))
                    continue;
                if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 20 && block.text.length < 1500) {
                    if (summary.truncatedUserGoals.length < 6) {
                        summary.truncatedUserGoals.push(block.text.slice(0, 600));
                    }
                }
            }
        }
    }
    return summary;
}
const SYSTEM_PROMPT = `You analyse one Claude Code session and propose 0–5 architectural decisions worth recording.

A decision is worth recording when it changes the structure of the system (libraries, modules, schemas, contracts, integrations) — NOT for routine bug fixes, formatting, comments, or content edits.

Return ONLY a JSON object:
{ "decisions": [ { "title": string, "why": string, "impact": string, "refs": string[] } ] }

Rules:
- Skip non-architectural work. If nothing qualifies, return { "decisions": [] }.
- "title" is a short headline. "why" is the trigger. "impact" is what changes.
- "refs" can include file paths edited in this session.
- Be conservative. Better 0 decisions than a wrong one.`;
export async function suggestDecisionsForSession(opts) {
    if (!llmAvailable())
        return [];
    let summary;
    try {
        summary = await summariseSession(opts.transcriptPath);
    }
    catch (e) {
        log.warn('decisionSuggest: summary failed', { err: e.message });
        return [];
    }
    // Heuristic: skip sessions with no edits AND few tools.
    if (summary.editedFiles.size === 0 && summary.totalAssistantTurns < 5)
        return [];
    const editedFilesList = [...summary.editedFiles].slice(0, 50);
    const topTools = Object.entries(summary.toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([t, c]) => `${t}×${c}`).join(', ');
    const userGoalsText = summary.truncatedUserGoals.length
        ? summary.truncatedUserGoals.map((g, i) => `(${i + 1}) ${g}`).join('\n\n')
        : '(none captured)';
    const userMsg = [
        `Session ${opts.sessionId} for group "${opts.group}".`,
        `Assistant turns: ${summary.totalAssistantTurns}`,
        `Top tools: ${topTools || 'none'}`,
        `Files edited (${editedFilesList.length}):\n${editedFilesList.map((f) => '  - ' + f).join('\n')}`,
        `User prompts (truncated):\n${userGoalsText}`,
        `Recent bash commands (sample): ${summary.bashCommands.slice(-12).join(' | ')}`,
    ].join('\n\n');
    let proposed = [];
    try {
        const res = await chat([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
        ], {
            purpose: 'decision_suggest',
            responseFormat: 'json_object',
            maxTokens: 900,
            group: opts.group,
        });
        const obj = JSON.parse(res.text);
        proposed = obj.decisions ?? [];
    }
    catch (e) {
        log.warn('decisionSuggest: LLM call failed', { err: e.message });
        return [];
    }
    if (proposed.length === 0)
        return [];
    const existing = readPendingDecisions(opts.group);
    const newSuggestions = proposed
        .filter((p) => p.title && p.why)
        .map((p, i) => ({
        id: `${opts.sessionId}-${i}-${Date.now().toString(36)}`,
        suggestedAt: new Date().toISOString(),
        sessionId: opts.sessionId,
        title: p.title,
        why: p.why,
        impact: p.impact ?? '',
        refs: Array.isArray(p.refs) ? p.refs : [],
        status: 'pending',
    }));
    writePending(opts.group, [...existing, ...newSuggestions]);
    log.info('decisionSuggest: stored suggestions', { group: opts.group, count: newSuggestions.length });
    return newSuggestions;
}
//# sourceMappingURL=decisionSuggest.js.map