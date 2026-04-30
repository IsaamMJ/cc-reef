import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, appendFileSync, writeFileSync, } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { log } from './log.js';
import { parseFrontmatter } from './frontmatter.js';
import { classifyHeuristic, TIER_FOR_TYPE } from './docTaxonomy.js';
const VALUABLE_NAMES = new Set([
    'prd', 'tdd', 'spec', 'specs', 'design', 'brief', 'requirements',
    'architecture', 'plan', 'roadmap', 'overview', 'scope',
    'technical-design', 'product-requirements', 'system-design',
    'proposal', 'rfc', 'vision', 'strategy', 'functional-spec', 'erd',
    'adr', 'decisions', 'changelog', 'notes', 'todo', 'backlog',
]);
const VALUABLE_FOLDERS = new Set([
    'docs', 'doc', 'spec', 'specs', 'design', 'designs', 'specifications',
    'documentation', 'planning', 'plans', 'rfcs',
]);
const EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
    '.nuxt', 'out', '.turbo', 'vendor', '__pycache__', '.venv', 'venv',
    '.cache', 'target', '.gradle', '.idea', '.vscode',
]);
function isValuable(absolutePath, rootPath) {
    const rel = relative(rootPath, absolutePath);
    const parts = rel.split(/[/\\]/);
    if (parts.some((p) => EXCLUDE_DIRS.has(p)))
        return false;
    const name = basename(absolutePath, extname(absolutePath)).toLowerCase();
    if (VALUABLE_NAMES.has(name))
        return true;
    const parentFolder = parts.length >= 2 ? (parts[parts.length - 2] ?? '').toLowerCase() : '';
    if (VALUABLE_FOLDERS.has(parentFolder))
        return true;
    return false;
}
function scanDir(dir, rootPath, depth, results) {
    if (depth > 4)
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
        if (stat.isDirectory()) {
            scanDir(full, rootPath, depth + 1, results);
        }
        else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
            if (isValuable(full, rootPath))
                results.push(full);
        }
    }
}
function buildDocFile(abs, rel, folderName) {
    const content = (() => { try {
        return readFileSync(abs, 'utf8');
    }
    catch {
        return '';
    } })();
    const fm = parseFrontmatter(content);
    const body = fm.body;
    // Title: first non-empty line of body (after frontmatter), preferring an H1.
    const firstLine = body.split('\n').find((l) => l.trim());
    const title = (typeof fm.data.title === 'string' && fm.data.title.trim()) ||
        firstLine?.replace(/^#+\s*/, '').trim() ||
        basename(abs, extname(abs));
    const preview = body.slice(0, 800).replace(/\n{3,}/g, '\n\n').trim();
    const mtime = (() => { try {
        return statSync(abs).mtimeMs;
    }
    catch {
        return 0;
    } })();
    // Classification: explicit frontmatter wins; else heuristic.
    let type;
    let tier;
    let inferred;
    const fmType = typeof fm.data.type === 'string' ? fm.data.type : undefined;
    if (fmType && fmType in TIER_FOR_TYPE) {
        type = fmType;
        tier = (typeof fm.data.tier === 'number' ? fm.data.tier : TIER_FOR_TYPE[fmType]);
        inferred = false;
    }
    else {
        const h = classifyHeuristic(rel, body);
        type = h.type;
        tier = h.tier;
        inferred = true;
    }
    const status = typeof fm.data.status === 'string' ? fm.data.status : undefined;
    const owners = Array.isArray(fm.data.owners) ? fm.data.owners.map(String) : undefined;
    const synopsisFm = typeof fm.data.synopsis === 'string' ? fm.data.synopsis : undefined;
    const sections = extractSections(body);
    return {
        relPath: rel, absolutePath: abs, projectFolder: folderName,
        title, preview, mtime,
        type, tier, status, owners,
        synopsis: synopsisFm,
        inferred, hasFrontmatter: fm.hasFrontmatter,
        sections,
    };
}
function extractSections(body) {
    const out = [];
    const lines = body.split('\n');
    for (const line of lines) {
        const m = line.match(/^(#{1,6})\s+(.*)$/);
        if (!m)
            continue;
        const level = m[1].length;
        const text = (m[2] ?? '').trim();
        // Explicit anchor: ## <a id="foo"></a> Title
        const anchorMatch = text.match(/<a\s+id=["']([^"']+)["']\s*>\s*<\/a>\s*(.*)$/i);
        if (anchorMatch) {
            out.push({ id: anchorMatch[1], title: (anchorMatch[2] ?? '').trim() || anchorMatch[1], level });
        }
        else {
            out.push({ id: slugify(text), title: text, level });
        }
    }
    return out;
}
function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
export function scanRepoDocs(diskPath, folderName) {
    if (!existsSync(diskPath))
        return [];
    const found = [];
    scanDir(diskPath, diskPath, 0, found);
    return found.map((abs) => buildDocFile(abs, relative(diskPath, abs), folderName))
        .sort((a, b) => a.relPath.localeCompare(b.relPath));
}
// Resolve a CC project folder name (e.g. "E--CCIsaam-cc-reef") to actual disk path.
// Tries all possible hyphen→separator combinations until finding an existing path.
export function resolveProjectPath(folderName) {
    const dashIdx = folderName.indexOf('--');
    if (dashIdx === -1)
        return null;
    const drive = folderName.slice(0, dashIdx);
    const rest = folderName.slice(dashIdx + 2);
    if (!rest) {
        const p = `${drive}:\\`;
        return existsSync(p) ? p : null;
    }
    const segments = rest.split('-');
    const driveRoot = `${drive}:\\`;
    // Try every combination of joining the segments with '-', '_', or path separators.
    // Folders on disk may use any of those, and the encoded `--` only marks drive boundary.
    function tryPaths(prefix, parts) {
        if (parts.length === 0)
            return existsSync(prefix) ? prefix : null;
        for (let i = 0; i < parts.length; i++) {
            const head = parts.slice(0, i + 1);
            // Try every joiner for this head: dash, underscore, or no separator.
            const joiners = ['-', '_', ''];
            for (const j of joiners) {
                const combined = head.join(j);
                const candidate = join(prefix, combined);
                if (!existsSync(candidate))
                    continue;
                const result = tryPaths(candidate, parts.slice(i + 1));
                if (result)
                    return result;
            }
        }
        return null;
    }
    return tryPaths(driveRoot, segments);
}
export function scanGroupRepoDocs(projects, extraDocPaths = []) {
    const all = [];
    const seen = new Set();
    for (const folder of projects) {
        const diskPath = resolveProjectPath(folder);
        if (!diskPath) {
            log.warn('docs: could not resolve project path', { folder });
            continue;
        }
        for (const doc of scanRepoDocs(diskPath, folder)) {
            if (!seen.has(doc.absolutePath)) {
                seen.add(doc.absolutePath);
                all.push(doc);
            }
        }
    }
    // Extra absolute doc paths configured per-group. We scan them broadly
    // (no "valuable" filter) — when the user explicitly points reef at a
    // folder, every .md file in it is treated as a doc.
    for (const rawPath of extraDocPaths) {
        if (!rawPath)
            continue;
        const root = rawPath.replace(/[/\\]+$/, '');
        if (!existsSync(root)) {
            log.warn('docs: configured docPath missing', { path: root });
            continue;
        }
        let stat;
        try {
            stat = statSync(root);
        }
        catch {
            continue;
        }
        if (stat.isFile() && extname(root).toLowerCase() === '.md') {
            // Single-file path.
            const rel = basename(root);
            if (!seen.has(root)) {
                seen.add(root);
                all.push(buildDocFile(root, rel, rel));
            }
            continue;
        }
        if (!stat.isDirectory())
            continue;
        const folderLabel = basename(root);
        const found = [];
        scanDirAll(root, 0, found);
        for (const abs of found) {
            if (seen.has(abs))
                continue;
            seen.add(abs);
            all.push(buildDocFile(abs, relative(root, abs), folderLabel));
        }
    }
    return all.sort((a, b) => a.projectFolder.localeCompare(b.projectFolder) || a.relPath.localeCompare(b.relPath));
}
// Walk an explicit doc folder collecting EVERY .md file (no valuable-name filter).
// User pointed reef at this folder, so trust it.
function scanDirAll(dir, depth, out) {
    if (depth > 6)
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
            scanDirAll(full, depth + 1, out);
        else if (stat.isFile() && extname(entry).toLowerCase() === '.md')
            out.push(full);
    }
}
export function getDecisionsFilePath(group) {
    return join(REEF_KNOWLEDGE, group.toLowerCase(), 'decisions.md');
}
export function getDecisionsJsonlPath(group) {
    return join(REEF_KNOWLEDGE, group.toLowerCase(), 'decisions.jsonl');
}
function newDecisionId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
}
function buildBody(d) {
    if (d.body && d.body.trim())
        return d.body.trim();
    const parts = [];
    if (d.title)
        parts.push(`**${d.title.trim()}**`);
    if (d.why)
        parts.push(`*Why:* ${d.why.trim()}`);
    if (d.impact)
        parts.push(`*Impact:* ${d.impact.trim()}`);
    if (d.refs && d.refs.length)
        parts.push(`*Refs:* ${d.refs.join(', ')}`);
    return parts.join('\n\n');
}
function readJsonlDecisions(group) {
    const path = getDecisionsJsonlPath(group);
    if (!existsSync(path))
        return [];
    const raw = readFileSync(path, 'utf8');
    const out = [];
    raw.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (!t)
            return;
        try {
            const o = JSON.parse(t);
            const ts = o.ts ?? '';
            const date = ts ? ts.slice(0, 10) : '';
            out.push({
                id: o.id ?? `legacy-${i}`,
                date,
                ts,
                title: o.title,
                why: o.why,
                impact: o.impact,
                refs: o.refs,
                project: o.project,
                body: o.body ?? buildBody(o),
                index: i,
                source: 'jsonl',
            });
        }
        catch {
            log.warn('decisions.jsonl: bad line', { group, lineNo: i + 1 });
        }
    });
    return out;
}
function readMarkdownDecisions(group) {
    const path = getDecisionsFilePath(group);
    if (!existsSync(path))
        return [];
    const raw = readFileSync(path, 'utf8');
    const body = raw.replace(/^# Decisions\n/, '');
    const blocks = body.split(/\n---\n/).filter((b) => b.trim());
    const entries = [];
    blocks.forEach((block, i) => {
        const lines = block.trim().split('\n');
        const dateLine = lines.find((l) => l.startsWith('**Date:**'));
        const date = dateLine?.replace('**Date:**', '').trim() ?? '';
        const text = lines.filter((l) => !l.startsWith('**Date:**')).join('\n').trim();
        if (text) {
            entries.push({
                id: `md-${i}`,
                date,
                body: text,
                index: i,
                source: 'md',
            });
        }
    });
    return entries;
}
export function readDecisions(group) {
    const merged = [...readMarkdownDecisions(group), ...readJsonlDecisions(group)];
    // Sort by ts/date asc; entries without timestamps preserve insertion order at the start.
    merged.sort((a, b) => {
        const ka = a.ts ?? a.date ?? '';
        const kb = b.ts ?? b.date ?? '';
        if (ka === kb)
            return a.index - b.index;
        return ka < kb ? -1 : 1;
    });
    return merged.map((e, i) => ({ ...e, index: i }));
}
export function appendDecision(group, entry) {
    const path = getDecisionsJsonlPath(group);
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const input = typeof entry === 'string' ? { body: entry } : entry;
    const body = buildBody(input);
    if (!body)
        return;
    const ts = new Date().toISOString();
    const record = {
        id: newDecisionId(),
        ts,
        title: input.title?.trim() || undefined,
        why: input.why?.trim() || undefined,
        impact: input.impact?.trim() || undefined,
        refs: input.refs && input.refs.length ? input.refs : undefined,
        project: input.project?.trim() || undefined,
        body,
    };
    const line = JSON.stringify(record) + '\n';
    if (!existsSync(path)) {
        writeFileSync(path, line, 'utf8');
    }
    else {
        appendFileSync(path, line, 'utf8');
    }
}
//# sourceMappingURL=docs.js.map