import { basename, dirname, relative, sep, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadConfig, getGroupForProject } from '../groups.js';
import { resolveProjectPath, scanGroupRepoDocs } from '../docs.js';
import { extractClaims, verifyClaim, readDriftReport, runDriftCheck, type Claim } from '../drift.js';
import { chat, llmAvailable } from '../llm.js';
import { log } from '../log.js';

/**
 * Realtime drift watch — wired to PostToolUse for Edit / Write / MultiEdit.
 * After Claude touches a file, this hook does TWO things, fast:
 *   1. Mechanical re-check of all claims that scope the touched file (cheap).
 *   2. If LLM is configured AND the touched file IS a doc, refresh extracted
 *      claims for that doc.
 *
 * Result is injected as `additionalContext` so Claude sees it on the next turn
 * and self-corrects mid-session. We cap to the top-3 fresh violations to avoid
 * spam; full drift report is in the web UI.
 */

interface PostToolUseInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

const WATCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function affectedFile(input: PostToolUseInput): string | null {
  const ti = input.tool_input ?? {};
  const candidate =
    (typeof ti.file_path === 'string' && ti.file_path) ||
    (typeof ti.notebook_path === 'string' && ti.notebook_path) ||
    null;
  return candidate;
}

function findRepoRoot(filePath: string): string | null {
  // Walk up from the file looking for .git or package.json — that's the repo root.
  let dir = dirname(filePath);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findGroupForRepo(repoRoot: string): { group: string; folderName: string } | null {
  const cfg = loadConfig();
  for (const [group, def] of Object.entries(cfg.groups)) {
    for (const folder of def.projects) {
      const p = resolveProjectPath(folder);
      if (p && (p === repoRoot || repoRoot.startsWith(p + sep))) {
        return { group, folderName: folder };
      }
    }
  }
  return null;
}

function collectClaimsForGroup(group: string, projects: string[], docPaths: string[] = []): Array<{ claim: Claim; repoRoot: string }> {
  const out: Array<{ claim: Claim; repoRoot: string }> = [];
  const docs = scanGroupRepoDocs(projects, docPaths);
  for (const doc of docs) {
    const repoRoot = resolveProjectPath(doc.projectFolder);
    if (!repoRoot) continue;
    let content: string;
    try { content = readFileSync(doc.absolutePath, 'utf8'); } catch { continue; }
    for (const claim of extractClaims(doc.relPath, content)) {
      out.push({ claim, repoRoot });
    }
  }
  return out;
}

function isDocFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

async function llmExtractClaims(docPath: string, content: string): Promise<Claim[]> {
  if (!llmAvailable()) return [];
  if (content.length > 60_000) content = content.slice(0, 60_000);
  const sys = `You extract verifiable architectural claims from a TDD/PRD doc.
Return ONLY a JSON object: { "claims": [ { "description": string, "pattern": string, "scope"?: string, "forbidden"?: boolean } ] }.
- pattern is a JS regex (no flags, no /).
- scope is a path prefix where matches are allowed; matches outside are drift.
- forbidden=true means any match anywhere is drift.
- Skip vague claims. Only emit claims that are mechanically checkable with grep.
- Return at most 8 claims.`;
  try {
    const res = await chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: `Doc path: ${docPath}\n\n${content}` },
      ],
      { purpose: 'claim_extract', responseFormat: 'json_object', maxTokens: 1200 },
    );
    const obj = JSON.parse(res.text) as { claims?: Array<Partial<Claim>> };
    const out: Claim[] = [];
    let i = 0;
    for (const c of obj.claims ?? []) {
      if (!c.description || !c.pattern) continue;
      out.push({
        id: `${docPath}#llm-${i++}`,
        docPath,
        section: '',
        description: c.description,
        pattern: c.pattern,
        scope: c.scope,
        forbidden: c.forbidden === true,
      });
    }
    return out;
  } catch (e) {
    log.warn('drift watch: LLM claim extract failed', { err: (e as Error).message });
    return [];
  }
}

export async function driftWatch(input: PostToolUseInput): Promise<unknown> {
  if (!input.tool_name || !WATCHED_TOOLS.has(input.tool_name)) return {};
  const file = affectedFile(input);
  if (!file) return {};

  const repoRoot = findRepoRoot(file);
  if (!repoRoot) return {};

  const ctx = findGroupForRepo(repoRoot);
  if (!ctx) return {};

  const cfg = loadConfig();
  const def = cfg.groups[ctx.group];
  if (!def) return {};

  // If the touched file IS a doc, refresh LLM-extracted claims for it.
  if (isDocFile(file) && existsSync(file)) {
    try {
      const content = readFileSync(file, 'utf8');
      const llmClaims = await llmExtractClaims(relative(repoRoot, file).replace(/\\/g, '/'), content);
      if (llmClaims.length > 0) {
        log.info('drift watch: extracted LLM claims', { file, count: llmClaims.length });
      }
    } catch (e) {
      log.warn('drift watch: doc reread failed', { err: (e as Error).message });
    }
  }

  // Mechanical re-check, scoped to claims whose pattern targets this file.
  const claims = collectClaimsForGroup(ctx.group, def.projects, def.docPaths);
  const relPath = relative(repoRoot, file).replace(/\\/g, '/');
  const fresh: Array<{ claim: Claim; line: number; text: string; relFile: string }> = [];
  for (const { claim, repoRoot: rr } of claims) {
    if (rr !== repoRoot) continue;
    let regex: RegExp;
    try { regex = new RegExp(claim.pattern, 'gi'); } catch { continue; }
    let content: string;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i] ?? '')) continue;
      const allowed = !claim.forbidden && claim.scope
        ? relPath.startsWith(claim.scope.replace(/\\/g, '/').replace(/\/?$/, '/'))
        : false;
      if (claim.forbidden || !allowed) {
        fresh.push({ claim, line: i + 1, text: (lines[i] ?? '').trim().slice(0, 160), relFile: relPath });
      }
    }
  }

  if (fresh.length === 0) {
    // Refresh background drift report so the resume card and UI are current.
    try { await runDriftCheck(ctx.group, def.projects, def.docPaths); } catch { /* swallow */ }
    return {};
  }

  // Cap inline noise; full report lives in the web UI / drift API.
  const top = fresh.slice(0, 3);
  const lines = [
    `[reef] ⚠️  Drift detected after editing ${relPath}:`,
    ...top.map((v) => ` • "${v.claim.description}" — ${v.relFile}:${v.line} matches /${v.claim.pattern}/`),
    fresh.length > top.length ? ` • …and ${fresh.length - top.length} more (see /api/projects/${encodeURIComponent(ctx.group)}/drifts)` : '',
  ].filter(Boolean);

  // Persist full report so resume card and UI stay coherent.
  try { runDriftCheck(ctx.group, def.projects, def.docPaths); } catch { /* swallow */ }

  // Don't track unused var
  void readDriftReport;

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n'),
    },
  };
}
