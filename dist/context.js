import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, } from 'node:fs';
import { join } from 'node:path';
import { REEF_COMPANIES, REEF_KNOWLEDGE } from './paths.js';
function ensureDir(p) {
    if (!existsSync(p))
        mkdirSync(p, { recursive: true });
}
// ---- Company Context ----
export function companyDir(company) {
    return join(REEF_COMPANIES, company);
}
export function getCompanyContextPath(company) {
    return join(companyDir(company), 'context.md');
}
export function readCompanyContext(company) {
    const p = getCompanyContextPath(company);
    if (!existsSync(p))
        return null;
    return readFileSync(p, 'utf8');
}
export function writeCompanyContext(company, content) {
    ensureDir(companyDir(company));
    writeFileSync(getCompanyContextPath(company), content, 'utf8');
}
// ---- Project Knowledge ----
export function projectDir(groupKey) {
    return join(REEF_KNOWLEDGE, groupKey.toLowerCase());
}
export function getProjectIntentPath(groupKey) {
    return join(projectDir(groupKey), 'intent.md');
}
export function getFyiPath(groupKey) {
    return join(projectDir(groupKey), 'fyi.md');
}
export function getDecisionsDir(groupKey) {
    return join(projectDir(groupKey), 'decisions');
}
export function readProjectIntent(groupKey) {
    const p = getProjectIntentPath(groupKey);
    if (!existsSync(p))
        return null;
    return readFileSync(p, 'utf8');
}
export function writeProjectIntent(groupKey, content) {
    ensureDir(projectDir(groupKey));
    writeFileSync(getProjectIntentPath(groupKey), content, 'utf8');
}
export function readFyiRecent(groupKey, maxEntries = 10) {
    const p = getFyiPath(groupKey);
    if (!existsSync(p))
        return null;
    const lines = readFileSync(p, 'utf8').split('\n');
    // Each entry starts with '## ' — find the last maxEntries blocks
    const blocks = [];
    let current = [];
    for (const line of lines) {
        if (line.startsWith('## ') && current.length > 0) {
            blocks.push(current.join('\n'));
            current = [line];
        }
        else {
            current.push(line);
        }
    }
    if (current.length > 0)
        blocks.push(current.join('\n'));
    return blocks.slice(-maxEntries).join('\n\n') || null;
}
export function appendFyiEntry(groupKey, entry) {
    ensureDir(projectDir(groupKey));
    const p = getFyiPath(groupKey);
    const date = new Date().toISOString().slice(0, 10);
    const block = `\n## ${date}\n${entry.trim()}\n`;
    appendFileSync(p, block, 'utf8');
}
export function createAdr(groupKey, title, context, decision, consequences) {
    const dir = getDecisionsDir(groupKey);
    ensureDir(dir);
    const existing = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')) : [];
    const num = String(existing.length + 1).padStart(3, '0');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const filename = `${num}-${slug}.md`;
    const date = new Date().toISOString().slice(0, 10);
    const content = [
        `# ADR ${num}: ${title}`,
        ``,
        `**Date:** ${date}  `,
        `**Status:** Accepted`,
        ``,
        `## Context`,
        ``,
        context.trim(),
        ``,
        `## Decision`,
        ``,
        decision.trim(),
        ``,
        `## Consequences`,
        ``,
        consequences.trim(),
        ``,
    ].join('\n');
    writeFileSync(join(dir, filename), content, 'utf8');
    return filename;
}
export function listAdrs(groupKey) {
    const dir = getDecisionsDir(groupKey);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter(f => f.endsWith('.md')).sort();
}
export function buildProjectContext(groupKey, displayName, company) {
    return {
        company,
        companyContext: company ? readCompanyContext(company) : null,
        groupKey,
        displayName,
        intent: readProjectIntent(groupKey),
        recentDecisions: readFyiRecent(groupKey, 10),
        adrCount: listAdrs(groupKey).length,
    };
}
//# sourceMappingURL=context.js.map