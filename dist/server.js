import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './db.js';
import { loadConfig, saveConfig, getGroupForProject, getGroupTrust, setGroupTrust, getGroupDisplayName, UNGROUPED, } from './groups.js';
import { buildProjectContext, writeProjectIntent, appendFyiEntry, createAdr, getDecisionsDir, getProjectIntentPath, } from './context.js';
import { listFyiEntries, pruneFyiByIndex, searchKnowledge, getOverview } from './knowledge.js';
import { scanGroupRepoDocs, readDecisions, appendDecision } from './docs.js';
import { readDocMeta } from './docMeta.js';
import { normaliseLayout, applyLayout, pruneLayout, emptyLayout } from './docLayout.js';
import { readDriftReport, runDriftCheck } from './drift.js';
import { getSpendSummary, getActiveProvider, llmAvailable, listModels, getDefaultModel, chatStream } from './llm.js';
import { listSessions as listChatSessions, getSession as getChatSession, createSession as createChatSession, deleteSession as deleteChatSession, appendMessage as appendChatMessage, touchSession as touchChatSession, autoTitleIfDefault as autoTitleChatIfDefault, } from './chat.js';
import { buildGroupContext, buildGroupContextWithOverride, buildArchitectModePrompt, buildAuditModePrompt, expandMentions, resolveDocRef, readDocBody } from './chatContext.js';
import { extractToolCalls, runTool } from './chatTools.js';
import { listTasks, createTask, updateTask, deleteTask, getTask } from './tasks.js';
import { runFullScan, readAlignmentSummary, applyTaskPatch } from './alignment.js';
import { readPendingDecisions, setPendingStatus } from './decisionSuggest.js';
import { readPendingPatches, proposeDocPatch, applyPatch, rejectPatch } from './docPatch.js';
import { autoReport } from './autoReport.js';
import { generateRetro } from './retro.js';
import { aiOverviewLine } from './summarize.js';
import { nimAvailable } from './nim.js';
import { log } from './log.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Attach LLM-cached synopsis (if available) to each doc. Pure read-side
 * enrichment — no classification, no tiering. Frontmatter synopsis always wins.
 */
function attachSynopses(group, docs) {
    const meta = readDocMeta(group);
    return docs.map((d) => {
        const m = meta[d.absolutePath];
        const synopsis = d.synopsis ?? (m ? m.synopsis : undefined);
        return synopsis === d.synopsis ? d : { ...d, synopsis };
    });
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
}
function notFound(res) {
    json(res, 404, { error: 'not found' });
}
function bad(res, msg) {
    json(res, 400, { error: msg });
}
// ------------- API handlers -------------
async function apiOverview(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const cfg = loadConfig();
    const db = getDb();
    const sessions = db
        .prepare(`SELECT session_id, project, ended_at, turn_count, tool_call_count,
              total_input_tokens, total_output_tokens, primary_model, summary
       FROM sessions WHERE ended_at IS NOT NULL AND ended_at >= ?`)
        .all(since);
    const totalSessions = sessions.length;
    const totalTurns = sessions.reduce((a, s) => a + s.turn_count, 0);
    const totalToolCalls = sessions.reduce((a, s) => a + s.tool_call_count, 0);
    const totalTokens = sessions.reduce((a, s) => a + s.total_input_tokens + s.total_output_tokens, 0);
    // Heatmap: sessions per day for last 90 days
    const heatmap = {};
    for (let i = 0; i < 90; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        heatmap[d] = 0;
    }
    for (const s of sessions) {
        const d = s.ended_at?.slice(0, 10);
        if (d && d in heatmap)
            heatmap[d] = (heatmap[d] ?? 0) + 1;
    }
    // Group breakdown
    const byGroup = new Map();
    for (const s of sessions) {
        const g = getGroupForProject(cfg, s.project) ?? UNGROUPED;
        byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
    }
    const groups = [...byGroup.entries()].map(([key, count]) => ({
        key,
        displayName: key === UNGROUPED ? UNGROUPED : getGroupDisplayName(cfg, key),
        company: cfg.groups[key]?.company ?? null,
        sessions: count,
    })).sort((a, b) => b.sessions - a.sessions);
    // Project momentum — sessions per day per group, last 14 days
    const momentumDays = [];
    for (let i = 13; i >= 0; i--) {
        momentumDays.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    }
    const momentum = new Map();
    for (const s of sessions) {
        const g = getGroupForProject(cfg, s.project) ?? UNGROUPED;
        const d = s.ended_at?.slice(0, 10);
        if (!d || !momentumDays.includes(d))
            continue;
        const row = momentum.get(g) ?? Object.fromEntries(momentumDays.map((x) => [x, 0]));
        row[d] = (row[d] ?? 0) + 1;
        momentum.set(g, row);
    }
    const momentumData = [...momentum.entries()]
        .map(([key, days]) => ({
        key,
        displayName: key === UNGROUPED ? UNGROUPED : getGroupDisplayName(cfg, key),
        total: Object.values(days).reduce((a, b) => a + b, 0),
        sparkline: momentumDays.map((d) => days[d] ?? 0),
    }))
        .sort((a, b) => b.total - a.total);
    // Open threads — last decision per group + doc count
    const openThreads = Object.keys(cfg.groups).map((key) => {
        const def = cfg.groups[key];
        const decisions = readDecisions(key);
        const lastDecision = decisions[decisions.length - 1];
        const docsCount = scanGroupRepoDocs(def.projects, def.docPaths).length;
        const recentSession = sessions.filter((s) => def.projects.includes(s.project))
            .sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? ''))[0];
        return {
            key,
            displayName: def.displayName ?? key,
            company: def.company ?? null,
            docsCount,
            decisionsCount: decisions.length,
            lastDecision: lastDecision ? { date: lastDecision.date, body: lastDecision.body.slice(0, 200) } : null,
            lastActive: recentSession?.ended_at ?? null,
            sessions: sessions.filter((s) => def.projects.includes(s.project)).length,
        };
    })
        .filter((r) => r.sessions > 0 || r.lastDecision)
        .sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
    // Recent sessions (with summaries)
    const recent = db.prepare(`SELECT session_id, project, ended_at, turn_count, tool_call_count, primary_model, summary
     FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 20`).all();
    closeDb();
    // AI overview line (best effort)
    let aiLine = null;
    if (nimAvailable()) {
        try {
            aiLine = await aiOverviewLine(days);
        }
        catch {
            aiLine = null;
        }
    }
    return {
        totals: { sessions: totalSessions, turns: totalTurns, toolCalls: totalToolCalls, tokens: totalTokens },
        heatmap,
        groups,
        momentum: momentumData,
        momentumDays,
        openThreads,
        aiLine,
        nimEnabled: nimAvailable(),
        recent: recent.map((s) => ({
            ...s,
            group: getGroupForProject(cfg, s.project) ?? UNGROUPED,
            displayName: (() => {
                const g = getGroupForProject(cfg, s.project);
                return g ? getGroupDisplayName(cfg, g) : UNGROUPED;
            })(),
        })),
    };
}
function apiProjectsList() {
    const cfg = loadConfig();
    const db = getDb();
    const sessionsByProject = db.prepare(`SELECT project, COUNT(*) c, MAX(ended_at) last FROM sessions GROUP BY project`).all();
    closeDb();
    const projectMap = new Map(sessionsByProject.map((r) => [r.project, r]));
    const rows = Object.keys(cfg.groups).sort().map((key) => {
        const def = cfg.groups[key];
        const sessions = def.projects.reduce((a, p) => a + (projectMap.get(p)?.c ?? 0), 0);
        const lastList = def.projects.map((p) => projectMap.get(p)?.last).filter(Boolean);
        const last = lastList.sort().pop() ?? null;
        const ov = getOverview(key);
        const docsCount = scanGroupRepoDocs(def.projects, def.docPaths).length;
        const decisionsCount = readDecisions(key).length;
        const driftReport = readDriftReport(key);
        const driftViolations = driftReport?.totals.violations ?? 0;
        return {
            key,
            displayName: def.displayName ?? key,
            company: def.company ?? null,
            trust: getGroupTrust(cfg, key),
            projects: def.projects,
            sessions,
            lastActive: last,
            hasIntent: ov.hasIntent,
            fyiCount: ov.fyiCount,
            adrCount: ov.adrCount,
            docsCount,
            decisionsCount,
            driftViolations,
        };
    });
    // Group by company. Groups with no company go under "(personal)".
    const PERSONAL = '(personal)';
    const byCompany = new Map();
    for (const r of rows) {
        const c = r.company ?? PERSONAL;
        const arr = byCompany.get(c) ?? [];
        arr.push(r);
        byCompany.set(c, arr);
    }
    const companies = [...byCompany.entries()]
        .map(([company, groups]) => ({
        company,
        groups: groups.sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? '')),
        sessions: groups.reduce((a, g) => a + g.sessions, 0),
        lastActive: groups.map((g) => g.lastActive).filter(Boolean).sort().pop() ?? null,
    }))
        .sort((a, b) => {
        if (a.company === PERSONAL)
            return 1;
        if (b.company === PERSONAL)
            return -1;
        return (b.lastActive ?? '').localeCompare(a.lastActive ?? '');
    });
    return { companies, groups: rows };
}
function apiProjectDetail(group) {
    const cfg = loadConfig();
    const def = cfg.groups[group];
    if (!def)
        return { error: 'group not found' };
    const trust = getGroupTrust(cfg, group);
    if (trust === 'deny')
        return { error: `trust tier is "deny"` };
    const ctx = buildProjectContext(group, def.displayName ?? group, def.company ?? null);
    const fyi = listFyiEntries(group);
    const adrDir = getDecisionsDir(group);
    const adrs = existsSync(adrDir)
        ? readdirSync(adrDir).filter((f) => f.endsWith('.md')).sort().map((f) => ({
            file: f,
            content: readFileSync(join(adrDir, f), 'utf8'),
        }))
        : [];
    // Project-scoped activity (last 30 days)
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const db = getDb();
    const placeholders = def.projects.map(() => '?').join(',') || "''";
    const sessions = def.projects.length > 0
        ? db.prepare(`SELECT session_id, project, ended_at, turn_count, tool_call_count, primary_model,
                total_input_tokens, total_output_tokens
         FROM sessions WHERE project IN (${placeholders}) AND ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY ended_at DESC`).all(...def.projects, since)
        : [];
    const heatmap = {};
    for (let i = 0; i < 90; i++) {
        heatmap[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = 0;
    }
    for (const s of sessions) {
        const d = s.ended_at?.slice(0, 10);
        if (d && d in heatmap)
            heatmap[d] = (heatmap[d] ?? 0) + 1;
    }
    const sessionIds = sessions.map((s) => s.session_id);
    let topTools = [];
    if (sessionIds.length > 0) {
        const ph = sessionIds.map(() => '?').join(',');
        topTools = db.prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls WHERE session_id IN (${ph})
       GROUP BY tool_name ORDER BY c DESC LIMIT 10`).all(...sessionIds)
            .map((r) => ({ tool: r.tool_name, count: r.c }));
    }
    const modelCount = new Map();
    for (const s of sessions) {
        if (s.primary_model)
            modelCount.set(s.primary_model, (modelCount.get(s.primary_model) ?? 0) + 1);
    }
    closeDb();
    const rawDocs = scanGroupRepoDocs(def.projects, def.docPaths);
    const docs = attachSynopses(group, rawDocs);
    const layout = normaliseLayout(def.docLayout ?? emptyLayout());
    const rendered = applyLayout(docs, layout);
    const decisions = readDecisions(group);
    const driftReport = readDriftReport(group);
    const pendingDecisions = readPendingDecisions(group).filter((d) => d.status === 'pending');
    const pendingPatches = readPendingPatches(group).filter((p) => p.status === 'pending');
    return {
        key: group,
        displayName: def.displayName ?? group,
        company: def.company ?? null,
        trust,
        projects: def.projects,
        intent: ctx.intent,
        companyContext: ctx.companyContext,
        fyi,
        adrs,
        docs,
        docLayout: rendered,
        decisions,
        driftReport,
        pendingDecisions,
        pendingPatches,
        activity: {
            heatmap,
            topTools,
            models: [...modelCount.entries()].map(([model, count]) => ({ model, count })),
            sessions: sessions.map((s) => ({
                sessionId: s.session_id,
                project: s.project,
                endedAt: s.ended_at,
                turns: s.turn_count,
                tools: s.tool_call_count,
                model: s.primary_model,
                tokens: s.total_input_tokens + s.total_output_tokens,
            })),
        },
    };
}
function apiKnowledgeSearch(q) {
    if (!q.trim())
        return { results: [] };
    const cfg = loadConfig();
    const results = [];
    for (const key of Object.keys(cfg.groups)) {
        const trust = getGroupTrust(cfg, key);
        if (trust === 'deny')
            continue;
        const r = searchKnowledge(key, q);
        const dn = cfg.groups[key].displayName ?? key;
        for (const e of r.fyi) {
            results.push({
                group: key, displayName: dn, type: 'fyi',
                ref: `${e.date} #${e.index}`,
                preview: e.body.slice(0, 240),
            });
        }
        for (const a of r.adrs) {
            results.push({
                group: key, displayName: dn, type: 'adr',
                ref: a.file, preview: a.snippet,
            });
        }
        // intent doc
        const intentPath = getProjectIntentPath(key);
        if (existsSync(intentPath)) {
            const content = readFileSync(intentPath, 'utf8');
            if (content.toLowerCase().includes(q.toLowerCase())) {
                const idx = content.toLowerCase().indexOf(q.toLowerCase());
                results.push({
                    group: key, displayName: dn, type: 'intent',
                    ref: 'intent.md',
                    preview: content.slice(Math.max(0, idx - 60), idx + 180).replace(/\n/g, ' '),
                });
            }
        }
    }
    return { query: q, results };
}
// ------------- Router -------------
async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
        // API
        if (path === '/api/overview') {
            const days = parseInt(url.searchParams.get('days') ?? '30', 10);
            const data = await apiOverview(days);
            return json(res, 200, data);
        }
        if (path === '/api/projects') {
            return json(res, 200, apiProjectsList());
        }
        if (path === '/api/spend') {
            const days = parseInt(url.searchParams.get('days') ?? '30', 10);
            const summary = getSpendSummary(days);
            return json(res, 200, {
                ...summary,
                provider: getActiveProvider(),
                llmAvailable: llmAvailable(),
                days,
            });
        }
        if (path === '/api/decisions') {
            const cfg = loadConfig();
            const groups = Object.keys(cfg.groups);
            const all = [];
            for (const g of groups) {
                const def = cfg.groups[g];
                const displayName = def.displayName ?? g;
                for (const d of readDecisions(g)) {
                    all.push({ ...d, group: g, groupDisplayName: displayName });
                }
            }
            all.sort((a, b) => {
                const ka = a.ts ?? a.date ?? '';
                const kb = b.ts ?? b.date ?? '';
                return ka < kb ? 1 : ka > kb ? -1 : 0;
            });
            const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
            const groupFilter = url.searchParams.get('group');
            const filtered = groupFilter ? all.filter((d) => d.group === groupFilter) : all;
            return json(res, 200, { decisions: filtered.slice(0, limit), total: filtered.length });
        }
        const projMatch = path.match(/^\/api\/projects\/([^/]+)$/);
        if (projMatch) {
            const group = decodeURIComponent(projMatch[1]);
            const data = apiProjectDetail(group);
            const status = data.error ? 404 : 200;
            return json(res, status, data);
        }
        const intentMatch = path.match(/^\/api\/projects\/([^/]+)\/intent$/);
        if (intentMatch && method === 'PUT') {
            const group = decodeURIComponent(intentMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (getGroupTrust(cfg, group) !== 'read-write')
                return bad(res, 'trust tier blocks writes');
            const body = await readBody(req);
            const content = body.content;
            if (typeof content !== 'string')
                return bad(res, 'content required');
            writeProjectIntent(group, content);
            return json(res, 200, { ok: true });
        }
        const fyiAddMatch = path.match(/^\/api\/projects\/([^/]+)\/fyi$/);
        if (fyiAddMatch && method === 'POST') {
            const group = decodeURIComponent(fyiAddMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (getGroupTrust(cfg, group) !== 'read-write')
                return bad(res, 'trust tier blocks writes');
            const body = await readBody(req);
            const entry = body.entry;
            if (typeof entry !== 'string' || !entry.trim())
                return bad(res, 'entry required');
            appendFyiEntry(group, entry);
            return json(res, 200, { ok: true });
        }
        const fyiDelMatch = path.match(/^\/api\/projects\/([^/]+)\/fyi\/(\d+)$/);
        if (fyiDelMatch && method === 'DELETE') {
            const group = decodeURIComponent(fyiDelMatch[1]);
            const idx = parseInt(fyiDelMatch[2], 10);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (getGroupTrust(cfg, group) !== 'read-write')
                return bad(res, 'trust tier blocks writes');
            const removed = pruneFyiByIndex(group, [idx]);
            return json(res, 200, { ok: true, removed });
        }
        const adrAddMatch = path.match(/^\/api\/projects\/([^/]+)\/adrs$/);
        if (adrAddMatch && method === 'POST') {
            const group = decodeURIComponent(adrAddMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (getGroupTrust(cfg, group) !== 'read-write')
                return bad(res, 'trust tier blocks writes');
            const b = await readBody(req);
            if (typeof b.title !== 'string' || typeof b.context !== 'string' ||
                typeof b.decision !== 'string' || typeof b.consequences !== 'string') {
                return bad(res, 'title, context, decision, consequences required');
            }
            const file = createAdr(group, b.title, b.context, b.decision, b.consequences);
            return json(res, 200, { ok: true, file });
        }
        const trustMatch = path.match(/^\/api\/projects\/([^/]+)\/trust$/);
        if (trustMatch && method === 'PUT') {
            const group = decodeURIComponent(trustMatch[1]);
            const b = await readBody(req);
            const t = b.trust;
            if (t !== 'read-write' && t !== 'read-only' && t !== 'deny')
                return bad(res, 'invalid trust tier');
            let cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            cfg = setGroupTrust(cfg, group, t);
            saveConfig(cfg);
            return json(res, 200, { ok: true, trust: t });
        }
        const docsMatch = path.match(/^\/api\/projects\/([^/]+)\/docs$/);
        if (docsMatch && method === 'GET') {
            const group = decodeURIComponent(docsMatch[1]);
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            const docs = attachSynopses(group, scanGroupRepoDocs(def.projects, def.docPaths));
            const layout = normaliseLayout(def.docLayout ?? emptyLayout());
            return json(res, 200, { docs, docLayout: applyLayout(docs, layout) });
        }
        const docLayoutMatch = path.match(/^\/api\/projects\/([^/]+)\/doc-layout$/);
        if (docLayoutMatch && method === 'PUT') {
            const group = decodeURIComponent(docLayoutMatch[1]);
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            const b = await readBody(req);
            const layout = normaliseLayout(b.layout);
            const docs = scanGroupRepoDocs(def.projects, def.docPaths);
            const pruned = pruneLayout(layout, docs);
            cfg.groups[group].docLayout = pruned;
            saveConfig(cfg);
            return json(res, 200, { ok: true, docLayout: applyLayout(docs, pruned) });
        }
        // ---- LLM models (global) ----
        if (path === '/api/llm/models' && method === 'GET') {
            if (!llmAvailable())
                return json(res, 200, { provider: null, models: [], defaultModel: null });
            const { guideFor, recommendedFor } = await import('./modelGuides.js');
            const models = await listModels();
            const enriched = models.map((m) => ({ ...m, guide: guideFor(m.id) }));
            // Pick chat default: env override > first recommended that's actually available > first model.
            const chatPrefs = recommendedFor('chat');
            const availableIds = new Set(enriched.map((m) => m.id));
            const recoChatPick = chatPrefs.find((id) => availableIds.has(id))
                ?? enriched.find((m) => m.guide?.tier === 'fast')?.id
                ?? enriched.find((m) => m.guide?.tier === 'flagship')?.id
                ?? enriched[0]?.id
                ?? getDefaultModel();
            return json(res, 200, {
                provider: getActiveProvider(),
                models: enriched,
                defaultModel: getDefaultModel(),
                chatDefault: process.env.REEF_CHAT_MODEL || recoChatPick,
                recommended: {
                    chat: chatPrefs,
                    classify: recommendedFor('classify'),
                    patch: recommendedFor('patch'),
                },
            });
        }
        // ---- Default system prompt for this project (used to prefill the editor) ----
        const sysPromptMatch = path.match(/^\/api\/projects\/([^/]+)\/system-prompt$/);
        if (sysPromptMatch && method === 'GET') {
            const group = decodeURIComponent(sysPromptMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            const ctx = buildGroupContext(group);
            return json(res, 200, { systemPrompt: ctx.systemPrompt });
        }
        // ---- Curated prompt presets ----
        const presetMatch = path.match(/^\/api\/projects\/([^/]+)\/system-prompt\/preset$/);
        if (presetMatch && method === 'GET') {
            const group = decodeURIComponent(presetMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            const which = url.searchParams.get('preset') ?? 'architect';
            const docName = url.searchParams.get('doc') ?? '';
            let prompt;
            if (which === 'audit' && docName)
                prompt = buildAuditModePrompt(group, docName);
            else
                prompt = buildArchitectModePrompt(group);
            return json(res, 200, { preset: which, systemPrompt: prompt });
        }
        // ---- Action Plan tasks ----
        const tasksListMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
        if (tasksListMatch && method === 'GET') {
            const group = decodeURIComponent(tasksListMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            return json(res, 200, { tasks: listTasks(group) });
        }
        if (tasksListMatch && method === 'POST') {
            const group = decodeURIComponent(tasksListMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            const b = await readBody(req);
            if (typeof b.title !== 'string' || !b.title.trim())
                return bad(res, 'title required');
            const t = createTask(group, {
                title: b.title.trim(),
                description: typeof b.description === 'string' ? b.description : undefined,
                priority: (['high', 'med', 'low'].includes(String(b.priority)) ? b.priority : 'med'),
                docRef: typeof b.docRef === 'string' ? b.docRef : undefined,
                source: typeof b.source === 'string' ? b.source : 'manual',
                evidence: typeof b.evidence === 'string' ? b.evidence : undefined,
            });
            return json(res, 200, t);
        }
        const taskOneMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
        if (taskOneMatch && method === 'PATCH') {
            const group = decodeURIComponent(taskOneMatch[1]);
            const id = decodeURIComponent(taskOneMatch[2]);
            const b = await readBody(req);
            const t = updateTask(group, id, b);
            if (!t)
                return notFound(res);
            return json(res, 200, t);
        }
        if (taskOneMatch && method === 'DELETE') {
            const group = decodeURIComponent(taskOneMatch[1]);
            const id = decodeURIComponent(taskOneMatch[2]);
            const ok = deleteTask(group, id);
            return json(res, ok ? 200 : 404, { ok });
        }
        // ---- Alignment scan ----
        const alignSumMatch = path.match(/^\/api\/projects\/([^/]+)\/alignment$/);
        if (alignSumMatch && method === 'GET') {
            const group = decodeURIComponent(alignSumMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            return json(res, 200, { summary: readAlignmentSummary(group), tasks: listTasks(group) });
        }
        const alignScanMatch = path.match(/^\/api\/projects\/([^/]+)\/alignment\/scan$/);
        if (alignScanMatch && method === 'POST') {
            const group = decodeURIComponent(alignScanMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (!llmAvailable())
                return bad(res, 'No LLM provider configured');
            try {
                const summary = await runFullScan(group);
                return json(res, 200, { summary, tasks: listTasks(group) });
            }
            catch (e) {
                return bad(res, `scan failed: ${e.message}`);
            }
        }
        // ---- Alignment export — markdown for second-opinion review (paste into Claude Code etc.) ----
        const alignExportMatch = path.match(/^\/api\/projects\/([^/]+)\/alignment\/export$/);
        if (alignExportMatch && method === 'GET') {
            const group = decodeURIComponent(alignExportMatch[1]);
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            const summary = readAlignmentSummary(group);
            const tasks = listTasks(group).filter((t) => t.status !== 'done' && (t.source ?? '').startsWith('alignment-scan'));
            const lines = [];
            lines.push(`# Alignment review: ${def.displayName ?? group}`);
            if (summary) {
                lines.push(`Last scan: ${summary.scannedAt} · ${summary.docsScanned} docs · ${summary.drifts.total} drifts (${summary.drifts.high} high / ${summary.drifts.med} med / ${summary.drifts.low} low)`);
            }
            lines.push('');
            lines.push(`Please review each finding below against the **current code, CLAUDE.md, and git log**. For each, respond with one of:`);
            lines.push(`- ✅ **confirmed** — the drift is real, action makes sense`);
            lines.push(`- 🛑 **disputed** — the drift is wrong; explain why (intentional removal, doc actually current, etc.)`);
            lines.push(`- ❓ **unclear** — needs more info`);
            lines.push('');
            lines.push(`---`);
            lines.push('');
            const byDoc = new Map();
            for (const t of tasks) {
                const k = t.docRef ?? '(unknown)';
                if (!byDoc.has(k))
                    byDoc.set(k, []);
                byDoc.get(k).push(t);
            }
            for (const [doc, items] of byDoc) {
                lines.push(`## 📄 ${doc}`);
                for (const t of items) {
                    const verdict = (t.source ?? '').replace('alignment-scan:', '');
                    lines.push(`### [${t.priority.toUpperCase()}] ${t.title}`);
                    lines.push(`Verdict from reef-chat: \`${verdict}\``);
                    if (t.description)
                        lines.push(`\n${t.description}`);
                    if (t.evidence)
                        lines.push(`\n**Evidence:**\n\`\`\`\n${t.evidence}\n\`\`\``);
                    lines.push('');
                }
            }
            const md = lines.join('\n');
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
            res.end(md);
            return;
        }
        // Apply a task's patch to the actual doc on disk (with backup).
        const applyMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/apply-patch$/);
        if (applyMatch && method === 'POST') {
            const group = decodeURIComponent(applyMatch[1]);
            const id = decodeURIComponent(applyMatch[2]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (!llmAvailable())
                return bad(res, 'No LLM provider configured');
            const result = await applyTaskPatch(group, id);
            return json(res, result.ok ? 200 : 400, result);
        }
        // ---- Propose a doc patch from a task (LLM call) ----
        const taskPatchMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/propose-patch$/);
        if (taskPatchMatch && method === 'POST') {
            const group = decodeURIComponent(taskPatchMatch[1]);
            const id = decodeURIComponent(taskPatchMatch[2]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (!llmAvailable())
                return bad(res, 'No LLM provider configured');
            const t = getTask(group, id);
            if (!t)
                return notFound(res);
            // Resolve docRef → doc body. If no docRef, error.
            const ctx = buildGroupContext(group);
            const docName = t.docRef ?? '';
            const doc = docName ? resolveDocRef(ctx, docName) : null;
            if (!doc)
                return bad(res, 'task has no resolvable docRef; set one before requesting a patch');
            const body = readDocBody(doc);
            const messages = [
                { role: 'system',
                    content: `You write minimal, surgical unified-diff patches for markdown docs in this project. Output ONLY a fenced \`\`\`diff block with the change. No prose.` },
                { role: 'user',
                    content: `Task: ${t.title}\n\nDescription:\n${t.description ?? '(none)'}\n\nEvidence:\n${t.evidence ?? '(none)'}\n\nDoc to update: ${doc.relPath}\n\n--- DOC BODY ---\n${body}\n\n--- END ---\n\nPropose a unified diff that addresses the task in this doc. Keep changes small and targeted.` },
            ];
            const { chat } = await import('./llm.js');
            const reply = await chat(messages, { purpose: 'doc_patch', group, maxTokens: 4096, temperature: 0.2 });
            return json(res, 200, { taskId: id, doc: doc.relPath, diff: reply.text, model: reply.model, costUsd: reply.costUsd });
        }
        // ---- Chat sessions ----
        const chatListMatch = path.match(/^\/api\/projects\/([^/]+)\/chats$/);
        if (chatListMatch && method === 'GET') {
            const group = decodeURIComponent(chatListMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            return json(res, 200, { sessions: listChatSessions(group) });
        }
        if (chatListMatch && method === 'POST') {
            const group = decodeURIComponent(chatListMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (!llmAvailable())
                return bad(res, 'No LLM provider configured');
            const b = await readBody(req);
            const model = (typeof b.model === 'string' && b.model) || process.env.REEF_CHAT_MODEL || getDefaultModel();
            const title = typeof b.title === 'string' ? b.title : 'New chat';
            const session = createChatSession(group, model, title);
            return json(res, 200, session);
        }
        const chatOneMatch = path.match(/^\/api\/projects\/([^/]+)\/chats\/([^/]+)$/);
        if (chatOneMatch && method === 'GET') {
            const group = decodeURIComponent(chatOneMatch[1]);
            const id = decodeURIComponent(chatOneMatch[2]);
            const s = getChatSession(group, id);
            if (!s)
                return notFound(res);
            return json(res, 200, s);
        }
        if (chatOneMatch && method === 'DELETE') {
            const group = decodeURIComponent(chatOneMatch[1]);
            const id = decodeURIComponent(chatOneMatch[2]);
            const ok = deleteChatSession(group, id);
            return json(res, ok ? 200 : 404, { ok });
        }
        if (chatOneMatch && method === 'PATCH') {
            const group = decodeURIComponent(chatOneMatch[1]);
            const id = decodeURIComponent(chatOneMatch[2]);
            const b = await readBody(req);
            const patch = {};
            if (typeof b.title === 'string' && b.title.trim())
                patch.title = b.title.trim().slice(0, 200);
            if (typeof b.model === 'string' && b.model.trim())
                patch.model = b.model.trim();
            // systemPrompt: empty string clears the override; non-empty replaces it.
            if (typeof b.systemPrompt === 'string')
                patch.systemPrompt = b.systemPrompt.slice(0, 8000);
            if (typeof b.presetName === 'string')
                patch.presetName = b.presetName.slice(0, 40);
            const meta = touchChatSession(group, id, patch);
            if (!meta)
                return notFound(res);
            return json(res, 200, meta);
        }
        // ---- Chat streaming reply (SSE) ----
        const chatStreamMatch = path.match(/^\/api\/projects\/([^/]+)\/chats\/([^/]+)\/stream$/);
        if (chatStreamMatch && method === 'POST') {
            const group = decodeURIComponent(chatStreamMatch[1]);
            const id = decodeURIComponent(chatStreamMatch[2]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (!llmAvailable())
                return bad(res, 'No LLM provider configured');
            const session = getChatSession(group, id);
            if (!session)
                return notFound(res);
            const b = await readBody(req);
            const userMsg = typeof b.message === 'string' ? b.message.trim() : '';
            if (!userMsg)
                return bad(res, 'message required');
            const overrideModel = typeof b.model === 'string' && b.model ? b.model : session.model;
            const openDocPath = typeof b.openDocPath === 'string' ? b.openDocPath : null;
            // Build system prompt + resolve mentions + auto-attach the open doc.
            // Per-session systemPrompt override wins over the default.
            const ctx = session.systemPrompt && session.systemPrompt.trim()
                ? buildGroupContextWithOverride(group, session.systemPrompt)
                : buildGroupContext(group);
            const mentioned = expandMentions(ctx, userMsg);
            const attachedPaths = mentioned.map((m) => m.doc.absolutePath);
            let openDocBlock = '';
            if (openDocPath) {
                const open = ctx.docs.find((d) => d.absolutePath === openDocPath);
                if (open && !attachedPaths.includes(open.absolutePath)) {
                    openDocBlock = `\n\n---\n[Currently open in reader: ${open.relPath}]\n\n${readDocBody(open)}`;
                    attachedPaths.push(open.absolutePath);
                }
            }
            const mentionsBlock = mentioned.length === 0 ? '' :
                '\n\n' + mentioned.map((m) => `---\n[Doc: ${m.doc.relPath}]\n\n${m.body}`).join('\n\n');
            const augmentedUser = userMsg + openDocBlock + mentionsBlock;
            // Persist user turn first.
            const userTs = new Date().toISOString();
            appendChatMessage(group, id, {
                role: 'user', content: userMsg, ts: userTs, contextDocs: attachedPaths,
            });
            autoTitleChatIfDefault(group, id, userMsg);
            if (overrideModel !== session.model)
                touchChatSession(group, id, { model: overrideModel });
            // Build the LLM message array.
            const llmMessages = [
                { role: 'system', content: ctx.systemPrompt },
                ...session.messages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: augmentedUser },
            ];
            // SSE response.
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            const send = (event, data) => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };
            send('start', { contextDocs: attachedPaths, model: overrideModel });
            let assistantText = ''; // full visible text (concatenated across tool-loop iterations)
            let totalIn = 0, totalOut = 0, totalCost = 0;
            let lastModel = overrideModel, lastProvider;
            const MAX_ITER = 10;
            let errored = false;
            try {
                for (let iter = 0; iter < MAX_ITER; iter++) {
                    let iterText = '';
                    let iterDone = false;
                    for await (const ev of chatStream(llmMessages, {
                        model: overrideModel, purpose: 'chat', group, maxTokens: 4096,
                    })) {
                        if (ev.type === 'delta' && ev.text) {
                            iterText += ev.text;
                            assistantText += ev.text;
                            send('delta', { text: ev.text });
                        }
                        else if (ev.type === 'done') {
                            totalIn += ev.inputTokens ?? 0;
                            totalOut += ev.outputTokens ?? 0;
                            totalCost += ev.costUsd ?? 0;
                            lastModel = ev.model ?? lastModel;
                            lastProvider = ev.provider ?? lastProvider;
                            iterDone = true;
                        }
                        else if (ev.type === 'error') {
                            send('error', { error: ev.error });
                            errored = true;
                            iterDone = true;
                        }
                    }
                    if (errored || !iterDone)
                        break;
                    // Detect tool calls in what the model just emitted this iteration.
                    const calls = extractToolCalls(iterText);
                    if (calls.length === 0)
                        break;
                    // Execute ALL calls this iteration (not just the first). Audits often
                    // need to fire 5–10 propose_task calls back-to-back; one-per-turn would
                    // burn through MAX_ITER. Cap at 12 per iteration as a safety valve.
                    const exec = calls.slice(0, 12);
                    const resultLines = [];
                    for (const call of exec) {
                        const result = await runTool(group, call.name, call.args);
                        send('tool', {
                            name: call.name, args: call.args,
                            summary: result.summary, ok: result.ok,
                            bodyPreview: result.body.slice(0, 200),
                        });
                        resultLines.push(`[tool result · ${call.name}${result.ok ? '' : ' · ERROR'}]\n${result.body}`);
                    }
                    // Append assistant turn (with the tool call text) + a synthetic user message
                    // carrying ALL the tool results. The model continues on the next iteration.
                    llmMessages.push({ role: 'assistant', content: iterText });
                    llmMessages.push({
                        role: 'user',
                        content: resultLines.join('\n\n---\n\n') + `\n\n(All ${exec.length} tool call(s) above have been executed. Now continue: either answer the user, or call more tools.)`,
                    });
                    // Visual separator in the assistant bubble.
                    const sep = `\n\n`;
                    assistantText += sep;
                    send('delta', { text: sep });
                }
            }
            catch (e) {
                send('error', { error: e.message });
            }
            if (assistantText) {
                appendChatMessage(group, id, {
                    role: 'assistant', content: assistantText, ts: new Date().toISOString(),
                    model: lastModel, inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost,
                });
            }
            send('done', {
                inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost,
                model: lastModel, provider: lastProvider,
            });
            res.end();
            return;
        }
        const docFileMatch = path.match(/^\/api\/projects\/([^/]+)\/doc$/);
        if (docFileMatch && method === 'GET') {
            const group = decodeURIComponent(docFileMatch[1]);
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            const wantedAbs = url.searchParams.get('path');
            if (!wantedAbs)
                return bad(res, 'path required');
            const allDocs = scanGroupRepoDocs(def.projects, def.docPaths);
            const doc = allDocs.find((d) => d.absolutePath === wantedAbs);
            if (!doc)
                return notFound(res);
            let content = '';
            try {
                const fs = await import('node:fs');
                content = fs.readFileSync(doc.absolutePath, 'utf8');
            }
            catch (e) {
                return bad(res, `read failed: ${e.message}`);
            }
            return json(res, 200, {
                relPath: doc.relPath,
                absolutePath: doc.absolutePath,
                projectFolder: doc.projectFolder,
                title: doc.title,
                content,
            });
        }
        const pendingDecMatch = path.match(/^\/api\/projects\/([^/]+)\/pending-decisions$/);
        if (pendingDecMatch && method === 'GET') {
            const group = decodeURIComponent(pendingDecMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            return json(res, 200, { decisions: readPendingDecisions(group) });
        }
        const pendingDecActMatch = path.match(/^\/api\/projects\/([^/]+)\/pending-decisions\/([^/]+)$/);
        if (pendingDecActMatch && method === 'POST') {
            const group = decodeURIComponent(pendingDecActMatch[1]);
            const id = decodeURIComponent(pendingDecActMatch[2]);
            const body = await readBody(req);
            const action = body.action;
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            if (action !== 'accept' && action !== 'reject')
                return bad(res, 'action must be accept|reject');
            const updated = setPendingStatus(group, id, action === 'accept' ? 'accepted' : 'rejected');
            if (!updated)
                return notFound(res);
            if (action === 'accept') {
                appendDecision(group, {
                    title: updated.title,
                    why: updated.why,
                    impact: updated.impact,
                    refs: updated.refs,
                });
                if (llmAvailable()) {
                    proposeDocPatch(group, def.projects, {
                        id: updated.id,
                        title: updated.title,
                        why: updated.why,
                        impact: updated.impact,
                        refs: updated.refs,
                    }, def.docPaths).catch(() => { });
                }
            }
            return json(res, 200, { ok: true });
        }
        const pendingPatchesMatch = path.match(/^\/api\/projects\/([^/]+)\/pending-patches$/);
        if (pendingPatchesMatch && method === 'GET') {
            const group = decodeURIComponent(pendingPatchesMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            return json(res, 200, { patches: readPendingPatches(group) });
        }
        const pendingPatchActMatch = path.match(/^\/api\/projects\/([^/]+)\/pending-patches\/([^/]+)$/);
        if (pendingPatchActMatch && method === 'POST') {
            const group = decodeURIComponent(pendingPatchActMatch[1]);
            const id = decodeURIComponent(pendingPatchActMatch[2]);
            const body = await readBody(req);
            const action = body.action;
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (action === 'apply') {
                const r = applyPatch(group, id);
                if (!r.ok)
                    return bad(res, r.error);
                return json(res, 200, { ok: true });
            }
            if (action === 'reject') {
                const r = rejectPatch(group, id);
                if (!r)
                    return notFound(res);
                return json(res, 200, { ok: true });
            }
            return bad(res, 'action must be apply|reject');
        }
        const driftsMatch = path.match(/^\/api\/projects\/([^/]+)\/drifts$/);
        if (driftsMatch) {
            const group = decodeURIComponent(driftsMatch[1]);
            const cfg = loadConfig();
            const def = cfg.groups[group];
            if (!def)
                return notFound(res);
            if (method === 'POST') {
                const report = await runDriftCheck(group, def.projects, def.docPaths);
                return json(res, 200, report);
            }
            if (method === 'GET') {
                const cached = readDriftReport(group);
                if (cached)
                    return json(res, 200, cached);
                return json(res, 200, { group, checkedAt: null, results: [], totals: { ok: 0, violations: 0, errors: 0 } });
            }
        }
        const decisionsMatch = path.match(/^\/api\/projects\/([^/]+)\/decisions$/);
        if (decisionsMatch) {
            const group = decodeURIComponent(decisionsMatch[1]);
            const cfg = loadConfig();
            if (!cfg.groups[group])
                return notFound(res);
            if (method === 'GET') {
                return json(res, 200, { decisions: readDecisions(group) });
            }
            if (method === 'POST') {
                const body = await readBody(req);
                const title = typeof body.title === 'string' ? body.title : undefined;
                const why = typeof body.why === 'string' ? body.why : undefined;
                const impact = typeof body.impact === 'string' ? body.impact : undefined;
                const project = typeof body.project === 'string' ? body.project : undefined;
                const refs = Array.isArray(body.refs)
                    ? body.refs.filter((r) => typeof r === 'string')
                    : undefined;
                const entry = typeof body.entry === 'string' ? body.entry : undefined;
                const hasStructured = !!(title || why || impact || (refs && refs.length));
                if (!hasStructured && !entry?.trim())
                    return bad(res, 'entry or title/why/impact required');
                appendDecision(group, hasStructured ? { title, why, impact, refs, project } : { body: entry });
                // Best-effort doc-patch proposal in the background — do not block the request.
                if (hasStructured && llmAvailable()) {
                    const cfg2 = loadConfig();
                    const def2 = cfg2.groups[group];
                    if (def2) {
                        proposeDocPatch(group, def2.projects, {
                            id: `srv-${Date.now().toString(36)}`,
                            title: title ?? '',
                            why,
                            impact,
                            refs,
                        }, def2.docPaths).catch((e) => {
                            // Already logged inside proposeDocPatch; nothing to do here.
                            void e;
                        });
                    }
                }
                return json(res, 200, { ok: true });
            }
        }
        if (path === '/api/knowledge/search') {
            return json(res, 200, apiKnowledgeSearch(url.searchParams.get('q') ?? ''));
        }
        if (path === '/api/retro') {
            const days = parseInt(url.searchParams.get('days') ?? '7', 10);
            return json(res, 200, { markdown: generateRetro({ days }) });
        }
        // Static — serve web/index.html for everything else
        if (path === '/' || !path.startsWith('/api/')) {
            const webDir = join(__dirname, '..', 'web');
            const file = path === '/' ? 'index.html' : path.slice(1);
            const full = join(webDir, file);
            if (existsSync(full) && full.startsWith(webDir)) {
                const ext = extname(full).toLowerCase();
                const type = ext === '.html' ? 'text/html'
                    : ext === '.css' ? 'text/css'
                        : ext === '.js' ? 'application/javascript'
                            : 'text/plain';
                res.writeHead(200, {
                    'content-type': type,
                    'cache-control': 'no-store, must-revalidate',
                });
                res.end(readFileSync(full));
                return;
            }
            const indexPath = join(webDir, 'index.html');
            if (existsSync(indexPath)) {
                res.writeHead(200, {
                    'content-type': 'text/html',
                    'cache-control': 'no-store, must-revalidate',
                });
                res.end(readFileSync(indexPath));
                return;
            }
        }
        notFound(res);
    }
    catch (e) {
        log.error('server error', { err: e.message });
        autoReport({
            source: `server:${req.method ?? '?'} ${(req.url ?? '').split('?')[0]}`,
            message: e.message ?? String(e),
            stack: e.stack,
        }).catch(() => { });
        json(res, 500, { error: e.message });
    }
}
export function startServer(port = 7777) {
    const server = createServer((req, res) => {
        handle(req, res).catch((e) => {
            log.error('handler crash', { err: e.message });
            autoReport({
                source: `server:handler-crash ${(req.url ?? '').split('?')[0]}`,
                message: e.message ?? String(e),
                stack: e.stack,
            }).catch(() => { });
            try {
                json(res, 500, { error: 'internal' });
            }
            catch { }
        });
    });
    server.listen(port, '127.0.0.1', () => {
        console.log(`reef serve — http://localhost:${port}`);
        console.log('Press Ctrl+C to stop.');
    });
}
//# sourceMappingURL=server.js.map