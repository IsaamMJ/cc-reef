/**
 * Alignment scan & patch application — the architect loop.
 *
 * runFullScan(group): non-streaming LLM scan of ALL docs in the group, one at a
 * time, against the codebase. Each finding becomes an ActionTask with a
 * verdict (code-fail / doc-stale). Stores a summary at
 * ~/.cc-reef/knowledge/<group>/alignment.json so the UI can show "last scan
 * 3 min ago, N drifts found".
 *
 * applyTaskPatch(group, taskId): asks the LLM for the FULL replacement body of
 * the task's docRef file, then writes it. Backs the original up to
 * <doc>.bak-<timestamp>. Idempotent enough that re-running re-fetches a fresh
 * patch.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { loadConfig } from './groups.js';
import { resolveDocRef, readDocBody, buildGroupContext } from './chatContext.js';
import { listTasks, createTask, getTask, updateTask } from './tasks.js';
import { chat } from './llm.js';
import { log } from './log.js';
function summaryPath(group) {
    return join(REEF_KNOWLEDGE, group.toLowerCase(), 'alignment.json');
}
export function readAlignmentSummary(group) {
    const p = summaryPath(group);
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function writeSummary(s) {
    const p = summaryPath(s.group);
    if (!existsSync(dirname(p))) {
        const fs = require('node:fs');
        fs.mkdirSync(dirname(p), { recursive: true });
    }
    writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
}
/** Tolerantly extract a JSON object with `findings: [...]` from any LLM output. */
function parseFindingsJson(raw) {
    let txt = raw.trim();
    // Strip ```json fences if present.
    const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence)
        txt = (fence[1] ?? '').trim();
    // Find first '{' .. matching '}'.
    const start = txt.indexOf('{');
    if (start === -1)
        return { ok: false, error: 'no JSON object found' };
    let depth = 0, end = -1, inStr = false, escape = false;
    for (let i = start; i < txt.length; i++) {
        const c = txt[i] ?? '';
        if (inStr) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === '\\') {
                escape = true;
                continue;
            }
            if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{')
            depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
    }
    if (end === -1)
        return { ok: false, error: 'unbalanced JSON' };
    try {
        const obj = JSON.parse(txt.slice(start, end));
        return { ok: true, findings: Array.isArray(obj.findings) ? obj.findings : [] };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
const FINDING_SYSTEM = `You are an architecture reviewer. Given (a) a project's living-truth (CLAUDE.md / drift log / decisions), (b) one target doc, and (c) the project's code repo summary (file tree + key files referenced by the doc), produce a STRICTLY JSON list of drift findings.

Output ONLY a JSON object: {"findings": [...]} with no prose.

Each finding has:
- severity: "high" | "med" | "low"
- verdict: "code-fails-doc" | "doc-stale" | "unverifiable"
- title: short fix summary (≤ 80 chars)
- description: 1–3 sentences explaining the drift
- evidence: a quote from the doc + a quote from code/living-truth that proves the drift

Rules:
- "doc-stale" applies when the LIVING-TRUTH says a thing was deleted/changed but the doc still describes it. Action implied: update the doc.
- "code-fails-doc" applies when the doc claim is current AND code lacks it. Action implied: build the code.
- "unverifiable" only when you genuinely cannot tell.
- Skip ✅ passes — only report drifts.
- 0–8 findings per doc. Be picky; only meaningful drifts.
- If nothing is wrong, return {"findings": []}.`;
export async function runFullScan(group) {
    const cfg = loadConfig();
    const def = cfg.groups[group];
    if (!def)
        throw new Error(`group not found: ${group}`);
    // Living truth — read once, share across docs.
    const ctx = buildGroupContext(group);
    const docs = ctx.docs;
    // Build a lightweight code summary: top-level file tree (first 200 entries).
    const codeSummary = listTopFiles(group);
    const errors = [];
    const drifts = { high: 0, med: 0, low: 0, total: 0 };
    let docsScanned = 0;
    for (const d of docs) {
        try {
            const body = readDocBody(d);
            const userMsg = `# Project: ${def.displayName ?? group}\n\n# Code summary (file tree, partial)\n\n${codeSummary}\n\n# Doc to audit: ${d.relPath}\n\n${body}`;
            let reply;
            try {
                reply = await chat([
                    { role: 'system', content: FINDING_SYSTEM },
                    { role: 'user', content: userMsg },
                ], { purpose: 'doc_classify', group, maxTokens: 2000, temperature: 0.2 });
            }
            catch (e) {
                errors.push(`${d.relPath}: LLM call failed — ${e.message}`);
                continue;
            }
            const parsed = parseFindingsJson(reply.text);
            if (!parsed.ok) {
                errors.push(`${d.relPath}: parse failed — ${parsed.error}. Raw head: ${reply.text.slice(0, 120)}`);
                continue;
            }
            const findings = (parsed.findings ?? []).slice(0, 12);
            // 'parsed' is the OK branch here.
            docsScanned++;
            for (const f of findings) {
                if (!f.title)
                    continue;
                const sev = ['high', 'med', 'low'].includes(f.severity) ? f.severity : 'med';
                // Don't duplicate: skip if there's an open task with same title + same docRef.
                const dup = listTasks(group).find((t) => t.status !== 'done' && t.docRef === d.relPath && t.title.trim() === f.title.trim());
                if (dup)
                    continue;
                createTask(group, {
                    title: f.title.slice(0, 200),
                    description: f.description,
                    priority: sev,
                    docRef: d.relPath,
                    source: `alignment-scan:${f.verdict}`,
                    evidence: f.evidence,
                });
                drifts[sev]++;
                drifts.total++;
            }
        }
        catch (e) {
            errors.push(`${d.relPath}: ${e.message}`);
            log.warn('alignment: doc scan failed', { doc: d.relPath, err: e.message });
        }
    }
    const summary = {
        group, scannedAt: new Date().toISOString(),
        docsScanned, drifts, errors: errors.slice(0, 20),
    };
    writeSummary(summary);
    return summary;
}
function listTopFiles(group) {
    const cfg = loadConfig();
    const def = cfg.groups[group];
    if (!def)
        return '';
    // Reuse scanGroupRepoDocs as a proxy — gets you doc files and project info, but
    // for a code summary we want a real recursive walk. For now, list the first ~200
    // file paths from project roots so the model can ground claims about modules.
    const fs = require('node:fs');
    const path = require('node:path');
    const seen = new Set();
    const out = [];
    const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', '.dart_tool', 'venv', '.venv', '__pycache__']);
    function resolveRoot(folder) {
        const dashIdx = folder.indexOf('--');
        if (dashIdx === -1)
            return null;
        const drive = folder.slice(0, dashIdx);
        const rest = folder.slice(dashIdx + 2);
        const segments = rest.split('-');
        const driveRoot = `${drive}:\\`;
        function tryP(prefix, parts) {
            if (parts.length === 0)
                return existsSync(prefix) ? prefix : null;
            for (let i = 0; i < parts.length; i++) {
                const head = parts.slice(0, i + 1);
                for (const j of ['-', '_', '']) {
                    const cand = path.join(prefix, head.join(j));
                    if (!existsSync(cand))
                        continue;
                    const r = tryP(cand, parts.slice(i + 1));
                    if (r)
                        return r;
                }
            }
            return null;
        }
        return tryP(driveRoot, segments);
    }
    for (const folder of def.projects) {
        const root = resolveRoot(folder);
        if (!root)
            continue;
        walk(root, root, 0);
    }
    function walk(root, cur, depth) {
        if (out.length >= 200 || depth > 6)
            return;
        let entries = [];
        try {
            entries = fs.readdirSync(cur);
        }
        catch {
            return;
        }
        for (const name of entries) {
            if (out.length >= 200)
                return;
            if (SKIP.has(name) || name.startsWith('.'))
                continue;
            const full = path.join(cur, name);
            let st;
            try {
                st = fs.statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory())
                walk(root, full, depth + 1);
            else if (st.isFile() && st.size < 200_000) {
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (!seen.has(rel)) {
                    seen.add(rel);
                    out.push(rel);
                }
            }
        }
    }
    return out.slice(0, 200).map((p) => `- ${p}`).join('\n');
}
// ---------------- Patch apply ----------------
const APPLY_SYSTEM = `You are a markdown editor. Given (a) a doc's current full body, (b) a task describing a fix to apply to that doc, return ONLY a JSON object {"newBody": "<full replacement>"} with no prose. Preserve unchanged sections verbatim. Make the smallest change needed.`;
export async function applyTaskPatch(group, taskId) {
    const t = getTask(group, taskId);
    if (!t)
        return { ok: false, error: 'task not found' };
    if (!t.docRef)
        return { ok: false, error: 'task has no docRef' };
    const ctx = buildGroupContext(group);
    const doc = resolveDocRef(ctx, t.docRef);
    if (!doc)
        return { ok: false, error: `doc not found: ${t.docRef}` };
    const cur = readDocBody(doc);
    const userMsg = `# Task\nTitle: ${t.title}\n\nDescription: ${t.description ?? ''}\n\nEvidence: ${t.evidence ?? ''}\n\n# Current doc body (${doc.relPath})\n\n${cur}`;
    let reply;
    try {
        reply = await chat([
            { role: 'system', content: APPLY_SYSTEM },
            { role: 'user', content: userMsg },
        ], { purpose: 'doc_patch', group, maxTokens: 6000, temperature: 0.1 });
    }
    catch (e) {
        return { ok: false, error: `LLM call failed: ${e.message}` };
    }
    // Tolerantly extract { newBody: "..." } from possibly fenced output.
    let txt = reply.text.trim();
    const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence)
        txt = (fence[1] ?? '').trim();
    const objStart = txt.indexOf('{');
    if (objStart === -1)
        return { ok: false, error: 'LLM did not return JSON' };
    let parsed = {};
    try {
        parsed = JSON.parse(txt.slice(objStart));
    }
    catch (e) {
        return { ok: false, error: `JSON parse failed: ${e.message}` };
    }
    const newBody = (parsed.newBody ?? '').trim();
    if (!newBody)
        return { ok: false, error: 'empty replacement body' };
    // Write a backup, then overwrite.
    const backup = `${doc.absolutePath}.bak-${Date.now()}`;
    try {
        if (existsSync(doc.absolutePath)) {
            writeFileSync(backup, readFileSync(doc.absolutePath));
        }
        writeFileSync(doc.absolutePath, newBody, 'utf8');
    }
    catch (e) {
        return { ok: false, error: `write failed: ${e.message}` };
    }
    // Mark task as in_progress so the user closes it after eyeballing.
    updateTask(group, taskId, { status: 'in_progress' });
    return { ok: true, doc: doc.relPath, backup };
}
//# sourceMappingURL=alignment.js.map