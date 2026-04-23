import { existsSync, readFileSync, statSync } from 'node:fs';
import { CLAUDE_SETTINGS, REEF_DB, REEF_CONFIG } from './paths.js';
import { getDb, closeDb } from './db.js';
import { loadConfig } from './groups.js';
import { listProjectFolders } from './projects.js';
function detectHooks() {
    const out = { sessionStart: false, bashNudge: false, postSession: false };
    if (!existsSync(CLAUDE_SETTINGS))
        return out;
    try {
        const raw = readFileSync(CLAUDE_SETTINGS, 'utf8');
        // Cheap substring search — avoids coupling to the schema version.
        out.sessionStart = raw.includes('hook session-start');
        out.bashNudge = raw.includes('hook bash-nudge');
        out.postSession = raw.includes('hook post-session');
    }
    catch {
        // ignore
    }
    return out;
}
export function getStatus() {
    const hooksInstalled = detectHooks();
    const dbExists = existsSync(REEF_DB);
    let dbSizeBytes = 0;
    let sessions = 0;
    let toolCalls = 0;
    let lastScannedAt = null;
    if (dbExists) {
        dbSizeBytes = statSync(REEF_DB).size;
        try {
            const db = getDb();
            sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
            toolCalls = db.prepare('SELECT COUNT(*) c FROM tool_calls').get().c;
            const row = db.prepare('SELECT MAX(scanned_at) m FROM sessions').get();
            lastScannedAt = row.m;
        }
        finally {
            closeDb();
        }
    }
    const cfg = loadConfig();
    const groupNames = Object.keys(cfg.groups);
    const assigned = new Set();
    for (const g of Object.values(cfg.groups)) {
        for (const p of g.projects)
            assigned.add(p);
    }
    const allProjects = listProjectFolders();
    const unassignedProjects = allProjects.filter((p) => !assigned.has(p)).length;
    return {
        hooksInstalled,
        settingsPath: CLAUDE_SETTINGS,
        dbExists,
        dbSizeBytes,
        sessions,
        toolCalls,
        lastScannedAt,
        groups: groupNames.length,
        unassignedProjects,
        configPath: REEF_CONFIG,
    };
}
function fmtBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function printStatus(s) {
    const ok = (b) => (b ? 'yes' : 'no ');
    const h = s.hooksInstalled;
    const allHooks = h.sessionStart && h.bashNudge && h.postSession;
    console.log('reef status');
    console.log(`  overall active        : ${allHooks && s.dbExists ? 'YES' : 'partial'}`);
    console.log(`  settings file         : ${s.settingsPath}`);
    console.log(`    SessionStart hook   : ${ok(h.sessionStart)}`);
    console.log(`    PreToolUse:Bash hook: ${ok(h.bashNudge)}`);
    console.log(`    Stop hook           : ${ok(h.postSession)}`);
    console.log(`  database              : ${s.dbExists ? fmtBytes(s.dbSizeBytes) : 'missing'}`);
    console.log(`    sessions tracked    : ${s.sessions}`);
    console.log(`    tool calls          : ${s.toolCalls}`);
    console.log(`    last scan           : ${s.lastScannedAt ?? 'never'}`);
    console.log(`  config                : ${s.configPath}`);
    console.log(`    groups              : ${s.groups}`);
    console.log(`    unassigned folders  : ${s.unassignedProjects}`);
}
//# sourceMappingURL=status.js.map