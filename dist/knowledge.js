import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getFyiPath, getDecisionsDir, getProjectIntentPath, } from './context.js';
import { getCompanyContextPath } from './context.js';
import { loadConfig } from './groups.js';
function parseFyi(raw) {
    const entries = [];
    const lines = raw.split('\n');
    let cur = null;
    for (const line of lines) {
        const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
        if (m) {
            if (cur)
                entries.push({ date: cur.date, body: cur.body.join('\n').trim(), index: entries.length });
            cur = { date: m[1], body: [] };
        }
        else if (cur) {
            cur.body.push(line);
        }
    }
    if (cur)
        entries.push({ date: cur.date, body: cur.body.join('\n').trim(), index: entries.length });
    return entries;
}
function serializeFyi(entries) {
    return entries.map((e) => `\n## ${e.date}\n${e.body}\n`).join('');
}
export function listFyiEntries(groupKey) {
    const p = getFyiPath(groupKey);
    if (!existsSync(p))
        return [];
    return parseFyi(readFileSync(p, 'utf8'));
}
export function searchKnowledge(groupKey, query) {
    const q = query.toLowerCase();
    const fyi = listFyiEntries(groupKey).filter((e) => e.body.toLowerCase().includes(q) || e.date.includes(q));
    const adrDir = getDecisionsDir(groupKey);
    const adrs = [];
    if (existsSync(adrDir)) {
        for (const f of readdirSync(adrDir).filter((x) => x.endsWith('.md'))) {
            const content = readFileSync(join(adrDir, f), 'utf8');
            if (content.toLowerCase().includes(q)) {
                const idx = content.toLowerCase().indexOf(q);
                const start = Math.max(0, idx - 60);
                const end = Math.min(content.length, idx + 120);
                adrs.push({ file: f, snippet: content.slice(start, end).replace(/\n/g, ' ') });
            }
        }
    }
    return { fyi, adrs };
}
export function pruneFyiBefore(groupKey, beforeIso) {
    const p = getFyiPath(groupKey);
    if (!existsSync(p))
        return 0;
    const before = beforeIso.slice(0, 10);
    const entries = parseFyi(readFileSync(p, 'utf8'));
    const kept = entries.filter((e) => e.date >= before);
    const removed = entries.length - kept.length;
    if (removed === 0)
        return 0;
    writeFileSync(p, serializeFyi(kept), 'utf8');
    return removed;
}
export function pruneFyiByIndex(groupKey, indices) {
    const p = getFyiPath(groupKey);
    if (!existsSync(p))
        return 0;
    const drop = new Set(indices);
    const entries = parseFyi(readFileSync(p, 'utf8'));
    const kept = entries.filter((_, i) => !drop.has(i));
    const removed = entries.length - kept.length;
    if (removed === 0)
        return 0;
    writeFileSync(p, serializeFyi(kept), 'utf8');
    return removed;
}
export function getOverview(groupKey) {
    const intentPath = getProjectIntentPath(groupKey);
    const fyiPath = getFyiPath(groupKey);
    const adrDir = getDecisionsDir(groupKey);
    return {
        groupKey,
        hasIntent: existsSync(intentPath),
        intentBytes: existsSync(intentPath) ? statSync(intentPath).size : 0,
        fyiCount: existsSync(fyiPath) ? parseFyi(readFileSync(fyiPath, 'utf8')).length : 0,
        fyiBytes: existsSync(fyiPath) ? statSync(fyiPath).size : 0,
        adrCount: existsSync(adrDir) ? readdirSync(adrDir).filter((f) => f.endsWith('.md')).length : 0,
    };
}
export function listAllOverviews() {
    const cfg = loadConfig();
    return Object.keys(cfg.groups).sort().map((k) => getOverview(k));
}
export function exportKnowledge(groupKey) {
    const cfg = loadConfig();
    const def = cfg.groups[groupKey];
    if (!def)
        throw new Error(`Group "${groupKey}" not found`);
    const out = [];
    out.push(`# Knowledge export — ${def.displayName ?? groupKey}`);
    out.push('');
    if (def.company) {
        const ccPath = getCompanyContextPath(def.company);
        if (existsSync(ccPath)) {
            out.push(`## Company: ${def.company}`);
            out.push('');
            out.push(readFileSync(ccPath, 'utf8'));
            out.push('');
        }
    }
    const intentPath = getProjectIntentPath(groupKey);
    if (existsSync(intentPath)) {
        out.push(`## Project Intent`);
        out.push('');
        out.push(readFileSync(intentPath, 'utf8'));
        out.push('');
    }
    const fyiPath = getFyiPath(groupKey);
    if (existsSync(fyiPath)) {
        out.push(`## Decision Log (fyi)`);
        out.push('');
        out.push(readFileSync(fyiPath, 'utf8'));
        out.push('');
    }
    const adrDir = getDecisionsDir(groupKey);
    if (existsSync(adrDir)) {
        const adrs = readdirSync(adrDir).filter((f) => f.endsWith('.md')).sort();
        if (adrs.length > 0) {
            out.push(`## ADRs`);
            out.push('');
            for (const f of adrs) {
                out.push(`---`);
                out.push('');
                out.push(readFileSync(join(adrDir, f), 'utf8'));
                out.push('');
            }
        }
    }
    return out.join('\n');
}
//# sourceMappingURL=knowledge.js.map