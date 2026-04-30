import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { resolveProjectPath, scanGroupRepoDocs } from './docs.js';
import { log } from './log.js';
const DEFAULT_CODE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.swift',
    '.rb', '.php', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
    '.dart', '.scala', '.sh', '.bash',
]);
const EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
    '.nuxt', 'out', '.turbo', 'vendor', '__pycache__', '.venv', 'venv',
    '.cache', 'target', '.gradle', '.idea', '.vscode',
]);
const CLAIM_BLOCK_RE = /<!--\s*@reef-claim\s+([\s\S]*?)-->/g;
function parseClaimBody(body) {
    const out = {};
    for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const idx = line.indexOf(':');
        if (idx === -1)
            continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key)
            out[key] = value;
    }
    return out;
}
function nearestHeading(content, charOffset) {
    // Walk back from offset to find the nearest preceding markdown heading.
    const before = content.slice(0, charOffset);
    const lines = before.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i]?.match(/^(#{1,6})\s+(.*)$/);
        if (m)
            return m[2].trim();
    }
    return '';
}
export function extractClaims(docPath, content) {
    const claims = [];
    let match;
    let n = 0;
    while ((match = CLAIM_BLOCK_RE.exec(content)) !== null) {
        const fields = parseClaimBody(match[1] ?? '');
        if (!fields.description || !fields.pattern) {
            log.warn('drift: claim missing description/pattern', { docPath });
            continue;
        }
        const ext = fields.ext
            ? fields.ext.split(',').map((e) => (e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`)).filter(Boolean)
            : undefined;
        claims.push({
            id: `${docPath}#${n++}`,
            docPath,
            section: nearestHeading(content, match.index ?? 0),
            description: fields.description,
            pattern: fields.pattern,
            scope: fields.scope || undefined,
            forbidden: fields.forbidden === 'true',
            ext,
        });
    }
    return claims;
}
function walkRepo(root, exts) {
    const out = [];
    function walk(dir, depth) {
        if (depth > 8)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (EXCLUDE_DIRS.has(entry))
                continue;
            const full = join(dir, entry);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (stat.isDirectory())
                walk(full, depth + 1);
            else if (stat.isFile() && exts.has(extname(entry).toLowerCase())) {
                out.push(full);
            }
        }
    }
    walk(root, 0);
    return out;
}
function normalizeScope(scope) {
    // Normalise to forward slashes with a trailing slash for prefix-matching.
    let s = scope.replace(/\\/g, '/');
    if (!s.endsWith('/'))
        s += '/';
    return s;
}
export function verifyClaim(claim, repoRoot) {
    let regex;
    try {
        regex = new RegExp(claim.pattern, 'gi');
    }
    catch (e) {
        return {
            claim,
            status: 'error',
            violations: [],
            matchCount: 0,
            errorMessage: `bad pattern: ${e.message}`,
        };
    }
    const exts = claim.ext && claim.ext.length
        ? new Set(claim.ext.map((e) => e.toLowerCase()))
        : DEFAULT_CODE_EXTS;
    const files = walkRepo(repoRoot, exts);
    const scope = claim.scope ? normalizeScope(claim.scope) : null;
    const violations = [];
    let matchCount = 0;
    for (const abs of files) {
        let content;
        try {
            content = readFileSync(abs, 'utf8');
        }
        catch {
            continue;
        }
        const lines = content.split('\n');
        let fileHadMatch = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? '';
            // Reset regex lastIndex per line because /g state is shared.
            regex.lastIndex = 0;
            if (!regex.test(line))
                continue;
            matchCount++;
            fileHadMatch = true;
            const rel = relative(repoRoot, abs).replace(/\\/g, '/');
            const allowed = !claim.forbidden && scope ? rel.startsWith(scope) : false;
            if (claim.forbidden || !allowed) {
                violations.push({
                    file: rel,
                    line: i + 1,
                    text: line.trim().slice(0, 200),
                });
            }
        }
        if (fileHadMatch && violations.length > 100)
            break; // safety cap
    }
    return {
        claim,
        status: violations.length === 0 ? 'ok' : 'violation',
        violations,
        matchCount,
    };
}
function getDriftsFilePath(group) {
    return join(REEF_KNOWLEDGE, group.toLowerCase(), 'drifts.json');
}
export async function runDriftCheck(group, projects, docPaths = []) {
    // Imported lazily to avoid a circular type-init issue (claimsExtract imports drift types).
    const { extractLlmClaims, combineClaims } = await import('./claimsExtract.js');
    const docs = scanGroupRepoDocs(projects, docPaths);
    const results = [];
    const repoForFolder = new Map();
    for (const folder of projects) {
        const p = resolveProjectPath(folder);
        if (p)
            repoForFolder.set(folder, p);
    }
    for (const doc of docs) {
        const repoRoot = repoForFolder.get(doc.projectFolder);
        if (!repoRoot)
            continue;
        let content;
        try {
            content = readFileSync(doc.absolutePath, 'utf8');
        }
        catch {
            continue;
        }
        const inlineClaims = extractClaims(doc.relPath, content);
        const llmClaims = await extractLlmClaims(group, doc.absolutePath, doc.relPath, content);
        const claims = combineClaims(inlineClaims, llmClaims);
        for (const claim of claims) {
            results.push(verifyClaim(claim, repoRoot));
        }
    }
    const totals = {
        ok: results.filter((r) => r.status === 'ok').length,
        violations: results.filter((r) => r.status === 'violation').length,
        errors: results.filter((r) => r.status === 'error').length,
    };
    const report = {
        group,
        checkedAt: new Date().toISOString(),
        results,
        totals,
    };
    // Persist last run.
    try {
        const path = getDriftsFilePath(group);
        const dir = dirname(path);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    }
    catch (e) {
        log.warn('drift: failed to persist report', { group, err: e.message });
    }
    return report;
}
export function readDriftReport(group) {
    const path = getDriftsFilePath(group);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (e) {
        log.warn('drift: cached report unreadable', { group, err: e.message });
        return null;
    }
}
//# sourceMappingURL=drift.js.map