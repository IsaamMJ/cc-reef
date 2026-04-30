/**
 * Chat tool execution for reef-chat.
 *
 * The model emits tool calls as plain text in this shape:
 *   <tool>NAME</tool>
 *   { "arg": "value" }
 *
 * We parse them out of the streamed text, execute server-side, and feed the
 * result back as a follow-up user message before re-streaming.
 *
 * Tools are sandboxed to the group's project repos + docPaths — the model
 * cannot read arbitrary files on the host.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, sep, isAbsolute, relative } from 'node:path';
import { loadConfig } from './groups.js';
import { resolveProjectPath, scanGroupRepoDocs, readDecisions } from './docs.js';
import { resolveDocRef, readDocBody, buildGroupContext } from './chatContext.js';
import { createTask, updateTask, listTasks, type TaskPriority, type TaskStatus } from './tasks.js';
import { log } from './log.js';

export interface ToolCall {
  name: string;
  argsRaw: string;
  args: Record<string, unknown>;
  /** Index in the source string where the call started, used to slice text around it. */
  startIdx: number;
  endIdx: number;
}

export interface ToolResult {
  /** A short one-liner shown to the user as a pill in the chat UI. */
  summary: string;
  /** Full text fed back to the model on the next iteration. */
  body: string;
  /** Soft error: `body` already explains it, but the UI can highlight it. */
  ok: boolean;
}

const KNOWN_TOOLS = new Set([
  'read_doc', 'list_decisions', 'list_files', 'read_file', 'grep_code',
  'propose_task', 'update_task', 'list_tasks',
  'git_log', 'git_show', 'git_diff', 'read_living_truth',
  'update_doc', 'apply_doc_change',
]);
// Two accepted formats:
//   1) <tool>NAME</tool>\n{json}   (canonical)
//   2) NAME { json }               (loose — the model often emits this; parse anyway)
//   3) `<tool>NAME</tool>` then later `{json}`
// Match either a `<tool>` wrapper or a bare known-tool word at the start of a line / after whitespace.
const HEADER_RE = /(?:<tool>(\w+)<\/tool>|(?:^|[\s>`])(\w+))/gm;

/**
 * Extract all complete tool calls from streamed text. Each call is the tool
 * NAME followed by a balanced JSON object. Bad/incomplete calls are skipped.
 *
 * Tolerates two formats so models that drop the <tool>...</tool> wrapper still
 * trigger: `<tool>read_doc</tool>\n{...}` and the looser `read_doc {...}`.
 * For the loose form, the matched word must be one of KNOWN_TOOLS to avoid
 * false positives (e.g. matching English text).
 */
export function extractToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const seenStarts = new Set<number>();
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(text)) !== null) {
    const wrapped = m[1];
    const bare = m[2];
    let name = wrapped ?? '';
    if (!name) {
      // Loose form — must be a known tool word to count.
      if (!bare || !KNOWN_TOOLS.has(bare)) continue;
      name = bare;
    }
    const headerStart = m.index;
    if (seenStarts.has(headerStart)) continue;

    // Find the next '{' after this header (skip whitespace, optional language tags like ```json).
    let i = headerStart + m[0].length;
    while (i < text.length && /[\s`]/.test(text[i] ?? '')) i++;
    // Allow an optional 'json' word.
    if (text.slice(i, i + 4).toLowerCase() === 'json') i += 4;
    while (i < text.length && /\s/.test(text[i] ?? '')) i++;
    if (text[i] !== '{') continue;

    let depth = 0;
    let j = i;
    let inStr = false;
    let escape = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    if (depth !== 0) continue;
    const argsRaw = text.slice(i, j);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch {
      continue;
    }
    seenStarts.add(headerStart);
    out.push({ name, argsRaw, args, startIdx: headerStart, endIdx: j });
  }
  // De-dup in case both wrapped + bare matched the same call.
  out.sort((a, b) => a.startIdx - b.startIdx);
  const dedup: ToolCall[] = [];
  for (const c of out) {
    if (dedup.some((d) => Math.abs(d.startIdx - c.startIdx) < 10 || (d.startIdx <= c.startIdx && d.endIdx >= c.endIdx))) continue;
    dedup.push(c);
  }
  return dedup;
}

// ---------------- Sandbox ----------------

function sandboxRoots(group: string): string[] {
  const cfg = loadConfig();
  const def = cfg.groups[group];
  if (!def) return [];
  const roots = new Set<string>();
  for (const folder of def.projects) {
    const p = resolveProjectPath(folder);
    if (p) roots.add(resolve(p));
  }
  for (const dp of def.docPaths ?? []) {
    if (existsSync(dp)) roots.add(resolve(dp));
  }
  return [...roots];
}

function withinSandbox(roots: string[], abs: string): boolean {
  const a = resolve(abs);
  for (const r of roots) {
    const rel = relative(r, a);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return true;
  }
  return false;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.idea',
  '.vscode', 'venv', '.venv', '__pycache__', '.pytest_cache', 'target',
  '.gradle', '.dart_tool', '.flutter-plugins-dependencies',
]);
const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','svg','pdf','zip','gz','tar',
  '7z','exe','dll','so','dylib','class','jar','wasm','bin','mp4','mov',
  'mp3','wav','ttf','otf','woff','woff2','psd','ai','sketch',
]);

function isBinary(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return BINARY_EXT.has(name.slice(dot + 1).toLowerCase());
}

// ---------------- Individual tool runners ----------------

function runReadDoc(group: string, args: Record<string, unknown>): ToolResult {
  const ref = String(args.name ?? args.path ?? args.id ?? '').trim();
  if (!ref) return { ok: false, summary: 'read_doc: missing "name"', body: 'Error: provide {"name": "<doc-stem-or-path>"}.' };
  const ctx = buildGroupContext(group);
  const doc = resolveDocRef(ctx, ref);
  if (!doc) {
    const known = ctx.docs.map((d) => d.relPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '')).filter(Boolean).slice(0, 30);
    return { ok: false, summary: `read_doc: not found "${ref}"`, body: `Doc "${ref}" not found. Known docs (sample): ${known.join(', ')}` };
  }
  const body = readDocBody(doc);
  return { ok: true, summary: `📖 read_doc · ${doc.relPath} (${body.length.toLocaleString()} chars)`, body: `# ${doc.relPath}\n\n${body}` };
}

function runListDecisions(group: string, args: Record<string, unknown>): ToolResult {
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const all = readDecisions(group);
  const recent = all.slice(-limit).reverse();
  if (recent.length === 0) return { ok: true, summary: 'list_decisions · 0 decisions', body: '_(no decisions logged for this project yet)_' };
  const lines = recent.map((e) => {
    const date = e.date || (e.ts ?? '').slice(0, 10);
    const head = e.title ? `**${e.title}**` : (e.body || '').split('\n')[0]?.slice(0, 80) ?? '';
    const why = e.why ? ` — Why: ${e.why}` : '';
    const impact = e.impact ? ` — Impact: ${e.impact}` : '';
    return `- (${date}) ${head}${why}${impact}`;
  });
  return { ok: true, summary: `📋 list_decisions · ${recent.length} returned`, body: lines.join('\n') };
}

function runListFiles(group: string, args: Record<string, unknown>): ToolResult {
  const roots = sandboxRoots(group);
  if (roots.length === 0) return { ok: false, summary: 'list_files: no project roots', body: 'No project repos configured for this group.' };
  const subPath = String(args.path ?? '').trim();
  const max = Math.min(300, Number(args.limit) || 200);
  const targetDirs: string[] = [];
  if (!subPath) {
    targetDirs.push(...roots);
  } else {
    let target: string | null = null;
    for (const r of roots) {
      const p = resolve(r, subPath);
      if (withinSandbox(roots, p) && existsSync(p) && statSync(p).isDirectory()) { target = p; break; }
    }
    if (!target) return { ok: false, summary: `list_files: not found "${subPath}"`, body: `Directory not found inside the project sandbox: ${subPath}` };
    targetDirs.push(target);
  }

  const results: string[] = [];
  let truncated = false;
  for (const dir of targetDirs) {
    walk(dir, dir, results, max);
    if (results.length >= max) { truncated = true; break; }
  }
  function walk(root: string, cur: string, acc: string[], cap: number): void {
    if (acc.length >= cap) return;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { return; }
    for (const name of entries) {
      if (acc.length >= cap) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(cur, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(root, full, acc, cap);
      } else if (st.isFile()) {
        if (isBinary(name)) continue;
        acc.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  const head = subPath ? `Files under ${subPath}:` : 'Files in project sandbox:';
  const body = `${head}\n${results.map((p) => `- ${p}`).join('\n')}${truncated ? `\n…(truncated at ${max})` : ''}`;
  return { ok: true, summary: `📂 list_files · ${results.length}${truncated ? '+' : ''}`, body };
}

function runReadFile(group: string, args: Record<string, unknown>): ToolResult {
  const roots = sandboxRoots(group);
  const p = String(args.path ?? '').trim();
  if (!p) return { ok: false, summary: 'read_file: missing "path"', body: 'Error: provide {"path": "<relative-or-absolute-path>"}.' };
  let abs: string | null = null;
  if (isAbsolute(p) && withinSandbox(roots, p) && existsSync(p)) abs = p;
  else {
    for (const r of roots) {
      const cand = resolve(r, p);
      if (withinSandbox(roots, cand) && existsSync(cand) && statSync(cand).isFile()) { abs = cand; break; }
    }
  }
  if (!abs) return { ok: false, summary: `read_file: not found "${p}"`, body: `File not found in sandbox: ${p}` };
  const name = abs.split(/[\\/]/).pop() ?? '';
  if (isBinary(name)) return { ok: false, summary: `read_file: binary "${name}"`, body: `Binary files not supported: ${name}` };
  const cap = Math.min(48_000, Number(args.maxChars) || 24_000);
  let content = '';
  try { content = readFileSync(abs, 'utf8'); }
  catch (e) { return { ok: false, summary: `read_file: ${(e as Error).message}`, body: `Read failed: ${(e as Error).message}` }; }
  const truncated = content.length > cap;
  if (truncated) content = content.slice(0, cap) + `\n\n…[truncated; original is ${content.length.toLocaleString()} chars]`;
  return { ok: true, summary: `📄 read_file · ${name} (${content.length.toLocaleString()} chars)`, body: `# ${abs}\n\n\`\`\`\n${content}\n\`\`\`` };
}

function runGrepCode(group: string, args: Record<string, unknown>): ToolResult {
  const roots = sandboxRoots(group);
  if (roots.length === 0) return { ok: false, summary: 'grep_code: no roots', body: 'No project repos.' };
  const patternStr = String(args.pattern ?? '').trim();
  if (!patternStr) return { ok: false, summary: 'grep_code: missing "pattern"', body: 'Error: provide {"pattern": "<regex>"}.' };
  let re: RegExp;
  try { re = new RegExp(patternStr, args.caseSensitive === true ? '' : 'i'); }
  catch (e) { return { ok: false, summary: `grep_code: bad pattern`, body: `Invalid regex: ${(e as Error).message}` }; }
  const scope = String(args.scope ?? '').trim();
  const max = Math.min(200, Number(args.limit) || 80);
  const matches: string[] = [];
  let scanned = 0;

  const targetRoots: string[] = scope
    ? roots.map((r) => resolve(r, scope)).filter((p) => withinSandbox(roots, p) && existsSync(p))
    : roots;
  if (targetRoots.length === 0) return { ok: false, summary: `grep_code: scope not found "${scope}"`, body: `Scope not found: ${scope}` };

  const SCAN_LIMIT = 2000;
  for (const r of targetRoots) {
    walk(r, r);
    if (matches.length >= max || scanned >= SCAN_LIMIT) break;
  }
  function walk(root: string, cur: string): void {
    if (matches.length >= max || scanned >= SCAN_LIMIT) return;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { return; }
    for (const name of entries) {
      if (matches.length >= max || scanned >= SCAN_LIMIT) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(cur, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(root, full);
      else if (st.isFile() && !isBinary(name) && st.size < 1_500_000) {
        scanned++;
        let txt = '';
        try { txt = readFileSync(full, 'utf8'); } catch { continue; }
        const lines = txt.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= max) return;
          if (re.test(lines[i] ?? '')) {
            const rel = relative(root, full).split(sep).join('/');
            matches.push(`${rel}:${i + 1}: ${lines[i]?.trim().slice(0, 200)}`);
          }
        }
      }
    }
  }
  if (matches.length === 0) return { ok: true, summary: `🔎 grep_code · 0 matches`, body: `No matches for /${patternStr}/${scope ? ' in ' + scope : ''}.` };
  return { ok: true, summary: `🔎 grep_code · ${matches.length} match${matches.length === 1 ? '' : 'es'}`, body: matches.join('\n') };
}

function asPriority(v: unknown): TaskPriority {
  return (['high', 'med', 'low'].includes(String(v)) ? String(v) : 'med') as TaskPriority;
}
function asStatus(v: unknown): TaskStatus {
  return (['todo', 'in_progress', 'done'].includes(String(v)) ? String(v) : 'todo') as TaskStatus;
}

function runProposeTask(group: string, args: Record<string, unknown>): ToolResult {
  const title = String(args.title ?? '').trim();
  if (!title) return { ok: false, summary: 'propose_task: missing "title"', body: 'Error: provide {"title": "...", "description"?, "priority"?, "docRef"?, "evidence"?}.' };
  const t = createTask(group, {
    title,
    description: args.description ? String(args.description) : undefined,
    priority: asPriority(args.priority),
    docRef: args.docRef ? String(args.docRef) : undefined,
    source: args.source ? String(args.source) : 'chat',
    evidence: args.evidence ? String(args.evidence) : undefined,
  });
  return {
    ok: true,
    summary: `📌 propose_task · "${t.title.slice(0, 60)}" [${t.priority}]`,
    body: `Task created: ${t.id} — "${t.title}" [${t.priority}]${t.docRef ? ` (about ${t.docRef})` : ''}. The user will see it in the Action Plan tab.`,
  };
}

function runUpdateTask(group: string, args: Record<string, unknown>): ToolResult {
  const id = String(args.id ?? '').trim();
  if (!id) return { ok: false, summary: 'update_task: missing "id"', body: 'Error: provide {"id": "t-...", "status"?, "priority"?, "title"?, "description"?}.' };
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) patch.title = String(args.title);
  if (args.description !== undefined) patch.description = String(args.description);
  if (args.priority !== undefined) patch.priority = asPriority(args.priority);
  if (args.status !== undefined) patch.status = asStatus(args.status);
  if (args.docRef !== undefined) patch.docRef = String(args.docRef);
  if (args.evidence !== undefined) patch.evidence = String(args.evidence);
  const t = updateTask(group, id, patch as never);
  if (!t) return { ok: false, summary: `update_task: not found "${id}"`, body: `No task with id ${id}.` };
  return { ok: true, summary: `✏️ update_task · ${t.id} → ${t.status}`, body: `Updated ${t.id}: status=${t.status}, priority=${t.priority}.` };
}

function runListTasks(group: string, args: Record<string, unknown>): ToolResult {
  const status = args.status ? String(args.status) : '';
  let items = listTasks(group);
  if (status) items = items.filter((t) => t.status === status);
  if (items.length === 0) return { ok: true, summary: `📋 list_tasks · 0`, body: '_(no tasks)_' };
  const lines = items.slice(0, 50).map((t) =>
    `- ${t.id} [${t.priority}] [${t.status}] ${t.title}${t.docRef ? ` (about ${t.docRef})` : ''}`,
  );
  return { ok: true, summary: `📋 list_tasks · ${items.length}`, body: lines.join('\n') };
}

// ---------------- Apply-doc-change (orchestrated; reliable for big docs) ----------------

async function runApplyDocChange(group: string, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.docRef ?? args.path ?? args.name ?? args.file ?? '').trim();
  const change = String(args.change ?? args.changeDescription ?? args.description ?? args.instruction ?? '').trim();
  const reason = String(args.reason ?? args.why ?? '').trim();
  if (!ref) return { ok: false, summary: 'apply_doc_change: missing "docRef"', body: 'Provide {"docRef": "<doc>", "change": "<what to change>", "reason"?: "<why>"}.' };
  if (!change) return { ok: false, summary: 'apply_doc_change: missing "change"', body: 'Describe the change in plain English; the runner will rewrite the doc.' };
  const ctx = buildGroupContext(group);
  const doc = resolveDocRef(ctx, ref);
  if (!doc) return { ok: false, summary: `apply_doc_change: not found "${ref}"`, body: `Doc "${ref}" not found.` };
  const cur = readDocBody(doc);
  // Single LLM call with high max_tokens; ask for {newBody} JSON.
  const sys = `You are a markdown editor. You will be given a doc's current full body and a description of a change to make. Return ONLY a JSON object {"newBody": "<the FULL replacement markdown>"} with no prose, no fences. Preserve unchanged sections verbatim. Apply the smallest correct edit.`;
  const user = `# Change to apply\n${change}${reason ? `\n\nReason: ${reason}` : ''}\n\n# Current doc body (${doc.relPath})\n\n${cur}`;
  const { chat } = await import('./llm.js');
  let reply;
  try {
    reply = await chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      { purpose: 'doc_patch', group, maxTokens: 8000, temperature: 0.1 },
    );
  } catch (e) {
    return { ok: false, summary: 'apply_doc_change: LLM call failed', body: `LLM error: ${(e as Error).message}` };
  }
  // Tolerant JSON extraction.
  let txt = reply.text.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = (fence[1] ?? '').trim();
  const objStart = txt.indexOf('{');
  if (objStart === -1) return { ok: false, summary: 'apply_doc_change: no JSON', body: 'LLM did not return JSON.' };
  let parsed: { newBody?: string } = {};
  try { parsed = JSON.parse(txt.slice(objStart)) as { newBody?: string }; }
  catch (e) { return { ok: false, summary: 'apply_doc_change: bad JSON', body: `JSON parse failed: ${(e as Error).message}` }; }
  const newBody = (parsed.newBody ?? '').trim();
  if (!newBody) return { ok: false, summary: 'apply_doc_change: empty body', body: 'LLM returned an empty replacement body.' };
  const backup = `${doc.absolutePath}.bak-${Date.now()}`;
  try {
    if (existsSync(doc.absolutePath)) writeFileSync(backup, readFileSync(doc.absolutePath));
    writeFileSync(doc.absolutePath, newBody, 'utf8');
  } catch (e) {
    return { ok: false, summary: 'apply_doc_change: write failed', body: `Write error: ${(e as Error).message}` };
  }
  return {
    ok: true,
    summary: `📝 apply_doc_change · ${doc.relPath} (${newBody.length.toLocaleString()} chars)${reason ? ' — ' + reason.slice(0, 60) : ''}`,
    body: `Doc updated: ${doc.relPath}\nBackup: ${backup}\nReason: ${reason || '(none)'}`,
  };
}

// ---------------- Doc write tool (sandboxed; writes a backup first) ----------------

function runUpdateDoc(group: string, args: Record<string, unknown>): ToolResult {
  // Accept whatever name the model picks: docRef / path / name / file / id.
  const ref = String(args.docRef ?? args.path ?? args.name ?? args.file ?? args.id ?? '').trim();
  // Accept newBody / body / content / markdown / text — the tool description says
  // "newBody" but models routinely substitute "content" or "markdown".
  const newBody = String(
    args.newBody ?? args.body ?? args.content ?? args.markdown ?? args.text ?? args.contents ?? '',
  ).trim();
  const reason = String(args.reason ?? args.why ?? '').trim();
  if (!ref) return { ok: false, summary: 'update_doc: missing "docRef"', body: 'Provide {"docRef": "<doc-stem-or-path>", "newBody": "<full markdown>", "reason": "..."}.' };
  if (!newBody) return { ok: false, summary: 'update_doc: missing "newBody"', body: 'Provide the FULL replacement markdown for the doc, not a diff.' };
  const ctx = buildGroupContext(group);
  const doc = resolveDocRef(ctx, ref);
  if (!doc) return { ok: false, summary: `update_doc: not found "${ref}"`, body: `Doc "${ref}" not found in this project.` };
  // Backup beside the original.
  const backup = `${doc.absolutePath}.bak-${Date.now()}`;
  try {
    if (existsSync(doc.absolutePath)) writeFileSync(backup, readFileSync(doc.absolutePath));
    writeFileSync(doc.absolutePath, newBody, 'utf8');
  } catch (e) {
    return { ok: false, summary: `update_doc: write failed`, body: `Write failed: ${(e as Error).message}` };
  }
  return {
    ok: true,
    summary: `📝 update_doc · ${doc.relPath} (${newBody.length.toLocaleString()} chars)${reason ? ' — ' + reason.slice(0, 60) : ''}`,
    body: `Doc updated: ${doc.relPath}\nBackup: ${backup}\n\nThe user will see the change reflected; if they object, the .bak file restores the previous content.`,
  };
}

// ---------------- Git tools (sandboxed) ----------------

function findRepoRoot(absPath: string): string | null {
  let cur = absPath;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function pickGitRoot(group: string, args: Record<string, unknown>): { root: string; relPath: string } | null {
  const roots = sandboxRoots(group);
  const p = String(args.path ?? '').trim();
  // Pick the first sandbox root that's inside a git repo, OR resolve `path` and walk up from it.
  let target: string | null = null;
  if (p) {
    if (isAbsolute(p) && withinSandbox(roots, p)) target = p;
    else {
      for (const r of roots) {
        const cand = resolve(r, p);
        if (withinSandbox(roots, cand) && existsSync(cand)) { target = cand; break; }
      }
    }
  }
  if (!target) target = roots[0] ?? null;
  if (!target) return null;
  const repo = findRepoRoot(target);
  if (!repo) return null;
  const rel = p ? relative(repo, target).split(sep).join('/') : '';
  return { root: repo, relPath: rel };
}

function gitRun(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

function runGitLog(group: string, args: Record<string, unknown>): ToolResult {
  const ctx = pickGitRoot(group, args);
  if (!ctx) return { ok: false, summary: 'git_log: no repo', body: 'No git repo found inside the project sandbox.' };
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
  const since = String(args.since ?? '').trim();
  const grep = String(args.grep ?? '').trim();
  const cmd = ['log', `--max-count=${limit}`, '--date=short', '--pretty=format:%h %ad %an %s'];
  if (since) cmd.push(`--since=${since}`);
  if (grep) cmd.push(`--grep=${grep}`);
  if (ctx.relPath) { cmd.push('--'); cmd.push(ctx.relPath); }
  let out = '';
  try { out = gitRun(ctx.root, cmd); }
  catch (e) { return { ok: false, summary: 'git_log: failed', body: `git error: ${(e as Error).message}` }; }
  if (!out.trim()) return { ok: true, summary: `🪵 git_log · 0 commits`, body: '_(no commits match)_' };
  const lines = out.split('\n').filter(Boolean);
  return { ok: true, summary: `🪵 git_log · ${lines.length} commits${ctx.relPath ? ' · ' + ctx.relPath : ''}`, body: lines.join('\n') };
}

function runGitShow(group: string, args: Record<string, unknown>): ToolResult {
  const ctx = pickGitRoot(group, args);
  if (!ctx) return { ok: false, summary: 'git_show: no repo', body: 'No git repo found.' };
  const ref = String(args.ref ?? args.hash ?? '').trim();
  if (!ref) return { ok: false, summary: 'git_show: missing "ref"', body: 'Provide {"ref": "<commit-hash-or-ref>"}.' };
  const cmd = ['show', '--stat', '--pretty=format:%h %ad %an%n%n%s%n%n%b%n', '--date=short', ref];
  let out = '';
  try { out = gitRun(ctx.root, cmd); }
  catch (e) { return { ok: false, summary: 'git_show: failed', body: `git error: ${(e as Error).message}` }; }
  const cap = Math.min(8000, Number(args.maxChars) || 5000);
  const truncated = out.length > cap;
  if (truncated) out = out.slice(0, cap) + `\n…[truncated; ${out.length} total chars]`;
  return { ok: true, summary: `🔬 git_show · ${ref}`, body: out };
}

function runGitDiff(group: string, args: Record<string, unknown>): ToolResult {
  const ctx = pickGitRoot(group, args);
  if (!ctx) return { ok: false, summary: 'git_diff: no repo', body: 'No git repo found.' };
  const fromRef = String(args.from ?? 'HEAD~1').trim();
  const toRef = String(args.to ?? 'HEAD').trim();
  const cmd = ['diff', '--stat', `${fromRef}..${toRef}`];
  if (ctx.relPath) { cmd.push('--'); cmd.push(ctx.relPath); }
  let out = '';
  try { out = gitRun(ctx.root, cmd); }
  catch (e) { return { ok: false, summary: 'git_diff: failed', body: `git error: ${(e as Error).message}` }; }
  const cap = Math.min(8000, Number(args.maxChars) || 5000);
  const truncated = out.length > cap;
  if (truncated) out = out.slice(0, cap) + `\n…[truncated]`;
  return { ok: true, summary: `🧮 git_diff · ${fromRef}..${toRef}`, body: out || '_(no diff)_' };
}

// ---------------- Living truth files (CLAUDE.md, AGENTS.md, drift logs) ----------------

const LIVING_TRUTH_NAMES = [
  'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CURSOR.md',
  'CHANGELOG.md', 'CHANGES.md', 'ARCHITECTURE.md',
];
const LIVING_TRUTH_PATTERNS = [
  /drift[-_]?log\.md$/i, /^DECISIONS?\.md$/i, /docs[/\\]decisions[/\\]/i,
  /docs[/\\]adr[/\\]/i, /^ADR-\d+/i,
];

function findLivingTruthFiles(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    walk(r, r, 0);
  }
  function walk(root: string, cur: string, depth: number): void {
    if (depth > 4 || out.length >= 30) return;
    let entries: string[] = [];
    try { entries = readdirSync(cur); } catch { return; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith('.') && name !== '.claude') continue;
      const full = join(cur, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(root, full, depth + 1);
      else if (st.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        if (LIVING_TRUTH_NAMES.includes(name)) out.push(full);
        else if (LIVING_TRUTH_PATTERNS.some((re) => re.test(rel) || re.test(name))) out.push(full);
      }
    }
  }
  return out;
}

function runReadLivingTruth(group: string, args: Record<string, unknown>): ToolResult {
  const roots = sandboxRoots(group);
  const files = findLivingTruthFiles(roots);
  if (files.length === 0) return { ok: true, summary: '📜 living_truth · 0 files', body: '_(no CLAUDE.md / AGENTS.md / drift log / ADR files found)_' };
  const cap = Math.min(40_000, Number(args.maxChars) || 20_000);
  const sections: string[] = [];
  let total = 0;
  for (const f of files) {
    if (total >= cap) break;
    let body = '';
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    const remaining = cap - total;
    if (body.length > remaining) body = body.slice(0, remaining) + `\n…[truncated]`;
    sections.push(`# ${f}\n\n${body}`);
    total += body.length + 50;
  }
  return { ok: true, summary: `📜 read_living_truth · ${files.length} file${files.length === 1 ? '' : 's'} (${total.toLocaleString()} chars)`, body: sections.join('\n\n---\n\n') };
}

// ---------------- Dispatcher ----------------

export async function runTool(group: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_doc': return runReadDoc(group, args);
      case 'list_decisions': return runListDecisions(group, args);
      case 'list_files': return runListFiles(group, args);
      case 'read_file': return runReadFile(group, args);
      case 'grep_code': return runGrepCode(group, args);
      case 'propose_task': return runProposeTask(group, args);
      case 'update_task': return runUpdateTask(group, args);
      case 'list_tasks': return runListTasks(group, args);
      case 'git_log': return runGitLog(group, args);
      case 'git_show': return runGitShow(group, args);
      case 'git_diff': return runGitDiff(group, args);
      case 'read_living_truth': return runReadLivingTruth(group, args);
      case 'update_doc': return runUpdateDoc(group, args);
      case 'apply_doc_change': return await runApplyDocChange(group, args);
      default:
        return { ok: false, summary: `unknown tool: ${name}`, body: `Tool "${name}" is not available. Tools: read_doc, list_decisions, list_files, read_file, grep_code, propose_task, update_task, list_tasks, git_log, git_show, git_diff, read_living_truth.` };
    }
  } catch (e) {
    log.warn('chatTools: tool threw', { name, err: (e as Error).message });
    return { ok: false, summary: `${name}: error`, body: `Tool execution error: ${(e as Error).message}` };
  }
}

/**
 * Description of available tools, injected into the system prompt.
 */
export const TOOLS_DESCRIPTION_V2 = `\nTools available (call by writing the tool name on its own line, then a JSON object on the next line(s)):

  <tool>read_doc</tool>
  {"name": "00-master-architecture-v2"}

After emitting a tool call, STOP and wait — the runner will execute it and feed the result back as a follow-up user message before you continue. Do not invent results.

Tools:
- read_doc({name|path}): full markdown body of one project doc. Use when a synopsis isn't enough.
- list_decisions({limit?}): recent decisions logged for this project.
- list_files({path?, limit?}): files inside the project repos (relative paths). Skips node_modules, dist, build, binaries.
- read_file({path, maxChars?}): full text of a source file inside the project sandbox. 24K char default cap.
- grep_code({pattern, scope?, limit?, caseSensitive?}): regex search across the project repos. Returns "path:line: match" lines.

Rules:
- One tool call per turn. After a result comes back, decide whether to call another or answer.
- Never claim a tool ran if you didn't see a tool result message come back.
- Stop calling tools once you have enough information to answer.`;
