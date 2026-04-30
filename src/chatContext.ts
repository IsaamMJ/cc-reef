/**
 * Build the chat system prompt for a project (group). The prompt always
 * includes:
 *   - The group's display name + identity
 *   - Group's docLayout (Vision / PRDs / TDDs / etc.) with each doc's title + synopsis
 *   - Recent decisions (last 10)
 *   - Available tool: read_doc(name)
 *
 * Full doc bodies are NOT in the system prompt — those are loaded on demand
 * via @mention or tool call. Keeps base context cheap (~1-3K tokens).
 */

import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './groups.js';
import { scanGroupRepoDocs, readDecisions, resolveProjectPath, type DocFile } from './docs.js';
import { readDocMeta } from './docMeta.js';
import { normaliseLayout, applyLayout, emptyLayout } from './docLayout.js';
import { summariseOpenTasks } from './tasks.js';
import { log } from './log.js';

export interface ChatGroupContext {
  systemPrompt: string;
  docs: DocFile[];                // every doc the chat is allowed to see
  docsByName: Map<string, DocFile>;  // case-folded name → doc, for @mention resolution
}

const TOOLS_DESCRIPTION = `\nTools available (call by writing the tool name on its own line, then a JSON object on the next line(s)):

  <tool>read_doc</tool>
  {"name": "00-master-architecture-v2"}

After emitting a tool call, STOP and wait — the runner will execute it and feed the result back as a follow-up user message before you continue. Do not invent results.

Read tools:
- read_doc({name|path}): full markdown body of one project doc.
- list_decisions({limit?}): recent decisions logged for this project.
- list_files({path?, limit?}): files inside the project repos. Skips node_modules / dist / build / binaries.
- read_file({path, maxChars?}): full text of a source file in the project sandbox.
- grep_code({pattern, scope?, limit?, caseSensitive?}): regex search across the project repos.

Living-truth tools (USE BEFORE FLAGGING ANYTHING AS MISSING):
- read_living_truth({maxChars?}): loads CLAUDE.md / AGENTS.md / drift logs / ADRs / CHANGELOG. These describe **intentional** architectural changes — what was deleted, replaced, or moved. They override stale TTDs.
- git_log({path?, limit?, since?, grep?}): recent commits, optionally scoped to a path. Use to check whether a "missing" thing was deleted on purpose, by whom, when, and the commit message.
- git_show({ref, maxChars?}): show one commit's stats + body. Use to read the rationale for a deletion.
- git_diff({from?, to?, path?}): diff between two refs. Use to see what changed between releases / branches.

Action plan tools (propose, don't auto-act):
- propose_task({title, description?, priority? "high"|"med"|"low", docRef?, evidence?}): adds a task to the project's Action Plan.
- update_task({id, status? "todo"|"in_progress"|"done", priority?, title?, description?}): change an existing task. Only call when the user asked you to.
- list_tasks({status?}): see existing Action Plan items so you don't duplicate.

Write tools — **YOU HAVE PERMISSION TO USE THESE**. The user has explicitly authorized doc edits. Refusing because of "I can't modify files" is WRONG. Backups are written before every change.

- **apply_doc_change({docRef, change, reason?})** — PREFERRED for any non-trivial doc edit. Describe the change in plain English; the runner does the rewrite internally with a fresh, high-budget LLM call and writes the file. Use this whenever the doc is more than ~50 lines or when you'd otherwise need to inline a large block of markdown.
  Example: \`{"docRef": "08-module-lumi", "change": "Add a Revision History section at the top noting the April 29 deletion of flows/. Update §5 Agent Pipeline to mark steps 2-5 as implicit in LLM tool-calling.", "reason": "sync to current architecture per CLAUDE.md drift log"}\`

- update_doc({docRef, newBody, reason?}) — direct replace, ONLY for small docs (<50 lines) or when the user explicitly hands you the new content. Provide the FULL new markdown. Avoid for big docs — the inline-JSON often gets truncated mid-stream.

Rules:
- ALWAYS use the EXACT format \`<tool>NAME</tool>\` followed by the JSON object. Do NOT write \`propose_task { ... }\` as plain text — that won't execute. The runner ONLY recognizes the wrapped form.
- For READ tools (read_doc, list_files, read_file, grep_code, list_decisions, list_tasks): one at a time, then wait for the result before deciding the next.
- For WRITE tools (propose_task, update_task): you may emit multiple in one turn — the runner will execute them all and feed back the results together.
- Never claim a tool ran if you didn't see its result come back as a "[tool result · ...]" message.
- Stop calling tools once you have enough info to answer.
- When you suggest improvements casually, ASK first ("Want me to add this to the Action Plan?") and only call propose_task after the user says yes — UNLESS the user explicitly asked for an audit/review, in which case add findings as tasks directly.`;

function indexByName(docs: DocFile[]): Map<string, DocFile> {
  const m = new Map<string, DocFile>();
  for (const d of docs) {
    const stem = d.relPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') ?? '';
    if (stem) m.set(stem.toLowerCase(), d);
    // Also index full title.
    if (d.title) m.set(d.title.toLowerCase(), d);
    // And the relative path without extension.
    m.set(d.relPath.replace(/\.md$/i, '').toLowerCase().replace(/\\/g, '/'), d);
  }
  return m;
}

function summariseLayout(group: string, docs: DocFile[]): string {
  const cfg = loadConfig();
  const def = cfg.groups[group];
  if (!def) return docs.map((d) => `- ${d.relPath} — ${d.synopsis ?? d.title}`).join('\n');
  const layout = normaliseLayout(def.docLayout ?? emptyLayout());
  const rendered = applyLayout(docs, layout);
  const lines: string[] = [];
  for (const g of rendered.groups) {
    if (g.docs.length === 0) continue;
    lines.push(`\n### ${g.name}`);
    for (const d of g.docs) {
      const stem = d.relPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') ?? d.relPath;
      const synopsis = d.synopsis ? ` — ${d.synopsis}` : '';
      lines.push(`- **${stem}**${synopsis}`);
    }
  }
  if (rendered.unsorted.length > 0) {
    lines.push(`\n### Unsorted`);
    for (const d of rendered.unsorted) {
      const stem = d.relPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') ?? d.relPath;
      const synopsis = d.synopsis ? ` — ${d.synopsis}` : '';
      lines.push(`- **${stem}**${synopsis}`);
    }
  }
  return lines.join('\n').trim();
}

function summariseDecisions(group: string, limit = 10): string {
  try {
    const all = readDecisions(group);
    if (!all.length) return '_(no decisions logged yet)_';
    const recent = all.slice(-limit).reverse();
    return recent.map((e) => {
      const date = e.date || (e.ts ?? '').slice(0, 10);
      const head = e.title ? `**${e.title}**` : (e.body || '').split('\n')[0]?.slice(0, 80) ?? '';
      const why = e.why ? ` — ${e.why}` : '';
      return `- (${date}) ${head}${why}`;
    }).join('\n');
  } catch (e) {
    log.warn('chatContext: decisions read failed', { err: (e as Error).message });
    return '_(decisions unavailable)_';
  }
}

/**
 * Attach LLM-cached synopses to scanned docs (read-only).
 */
function attachSynopses(group: string, docs: DocFile[]): DocFile[] {
  const meta = readDocMeta(group);
  return docs.map((d) => {
    if (d.synopsis) return d;
    const m = meta[d.absolutePath];
    return m && m.synopsis ? { ...d, synopsis: m.synopsis } : d;
  });
}

export function buildGroupContext(group: string): ChatGroupContext {
  const cfg = loadConfig();
  const def = cfg.groups[group];
  const displayName = def?.displayName ?? group;
  const company = def?.company;

  const docs = def
    ? attachSynopses(group, scanGroupRepoDocs(def.projects, def.docPaths))
    : [];

  const layoutSummary = summariseLayout(group, docs);
  const decisionsSummary = summariseDecisions(group);
  const tasksSummary = summariseOpenTasks(group);
  const companyLine = company ? ` (company: ${company})` : '';

  // Resolved sandbox roots — what list_files / read_file / grep_code can actually see.
  const sandboxRoots: string[] = [];
  if (def) {
    for (const folder of def.projects) {
      const p = resolveProjectPath(folder);
      if (p) sandboxRoots.push(p);
    }
    for (const dp of def.docPaths ?? []) {
      if (existsSync(dp)) sandboxRoots.push(dp);
    }
  }
  const sandboxList = sandboxRoots.length === 0
    ? '_(no project folders resolved — code tools will return empty)_'
    : sandboxRoots.map((r) => `- \`${r}\``).join('\n');

  const systemPrompt = `You are reef-chat, a helpful engineering assistant pair-programming on a specific software project.

# Project: ${displayName}${companyLine}

The docs and decisions below are this project's source of truth. Treat them as primary context — but you are NOT walled off from general knowledge. You can answer general engineering, language, framework, and tooling questions whenever they help the user. You don't need to refuse, hedge, or claim you "lack access" — answer the question and say what you'd need to verify it.

# Documentation index

Below is the project's organised doc layout. Each entry is "**filename** — one-line synopsis". To read a doc's full body, call the \`read_doc\` tool. If a synopsis is enough, use it; if you need more, read the doc.

${layoutSummary || '_(no docs scanned yet)_'}

# Recent decisions

${decisionsSummary}

# Action Plan (open tasks)

${tasksSummary}

# Code sandbox (what \`list_files\` / \`read_file\` / \`grep_code\` can see)

${sandboxList}

You can pass paths as either (a) absolute, if they sit inside one of the roots above, or (b) relative — the runner resolves them against each root. If a path you expect is missing, retry with the absolute path or with a more specific subpath; do NOT conclude "no access" after a single attempt.

# How to behave

- **Be short and crisp.** Default to 3–6 sentences. Use bullets only when you have ≥3 distinct items. No throat-clearing, no recap of what the user just said, no closing "let me know if…" lines unless genuinely needed. If a one-liner answers the question, give a one-liner.
- For audits or reviews: skip the prose summary, jump to findings. Each finding = one bullet (≤2 lines). End with "added N tasks to the Action Plan" — that's it.
- Be direct and useful. Don't refuse on the basis of "scope" — if the user asks a general question, answer it.
- When citing project specifics, name the doc you're drawing from.
- If asked to evaluate or critique docs, do it from a software-architecture lens: clarity, consistency, gaps, contradictions, missing concerns (auth, observability, deployment, etc.).
- If asked to update a doc, **call \`update_doc\`** with the full new markdown body. Do NOT respond with a unified diff or "you can copy/paste this manually" — the user has the tool wired up and expects you to use it. A backup is written automatically. Only fall back to a textual diff if \`update_doc\` returns an error.
- If you genuinely don't know something and it's not in the docs, say so and suggest where to look.
${TOOLS_DESCRIPTION}`;

  return {
    systemPrompt,
    docs,
    docsByName: indexByName(docs),
  };
}

/**
 * Same as buildGroupContext but with the system prompt replaced by the user-supplied
 * override sent VERBATIM. Nothing is appended — the user is fully in control of what
 * the model sees. The docs list (for @mention resolution) is still loaded so
 * read_doc and mentions still work if the override mentions them.
 */
export function buildGroupContextWithOverride(group: string, override: string): ChatGroupContext {
  const base = buildGroupContext(group);
  return { ...base, systemPrompt: override };
}

/**
 * Curated preset prompts the user can load via "Architect mode" / "Audit mode" buttons.
 * Each preset assumes the runtime appends doc index + decisions + tools, but since override
 * is sent verbatim, presets re-include those reference sections inline using the same
 * builder so the model has everything it needs.
 */
export function buildArchitectModePrompt(group: string): string {
  const base = buildGroupContext(group);
  // Replace only the persona/behavior block — keep the auto-generated reference sections
  // by extracting everything from "# Documentation index" onward.
  const refStart = base.systemPrompt.indexOf('# Documentation index');
  const refTail = refStart >= 0 ? base.systemPrompt.slice(refStart) : '';
  return `You are reef-chat in **Architect Mode** — a senior software architect reviewing this project.

# Project: ${loadConfig().groups[group]?.displayName ?? group}

Your job is to read the docs, cross-check claims against the actual codebase, find gaps and contradictions, and turn each finding into an actionable task in the Action Plan.

# How you work
- **Be short and crisp.** No prose padding. Findings as bullets, ≤2 lines each.
- **Ground yourself first.** Before flagging anything as missing/wrong, call \`read_living_truth\` and check git_log for the area in question. Many "missing" things were intentionally deleted — the docs just didn't catch up. If the deletion is logged in CLAUDE.md / drift log / git history, the finding is **doc-stale (update the doc)**, NOT **code-missing (rebuild the thing)**. Confusing these two is the #1 way to waste the user's time.
- Be skeptical of doc claims. Verify with grep_code / read_file when stakes are high (security, data, integrations, scaling).
- One concrete finding per task. "Vision is unclear" → bad; "Vision §Goals lacks Phase 1 retention metric" → good.
- Priority: high = blocks correctness/security/launch · med = clarity/completeness gap · low = polish.
- Final summary: one line. "N findings · added X tasks (Y code-fails / Z doc-stale). Top 3: …"

${refTail}`;
}

export function buildAuditModePrompt(group: string, docName: string): string {
  const base = buildGroupContext(group);
  const refStart = base.systemPrompt.indexOf('# Documentation index');
  const refTail = refStart >= 0 ? base.systemPrompt.slice(refStart) : '';
  return `You are reef-chat in **Audit Mode** — verifying a single doc against the actual codebase.

# Audit target: ${docName}

# Plan (follow this order, do NOT skip steps)
1. **read_living_truth({})** FIRST — load CLAUDE.md, AGENTS.md, drift logs, ADRs, CHANGELOG. These describe **intentional** architectural changes that may have superseded the doc you're about to audit. If the doc you're auditing is stale on a topic, the living-truth files will say so.
2. **read_doc({"name": "${docName}"})** — load the full target doc.
3. Extract concrete claims from the doc: integrations, modules, storage choices, flows, libraries, file/path conventions, "only" / "always" / "never" assertions, performance numbers. 5–15 claims. Skip vague aspirations.
4. For EACH claim, verify it. The verdict has FOUR possible outcomes:
   - ✅ **pass** — code matches the doc claim.
   - ❌ **code-fails-doc** — code contradicts the doc, AND living-truth/git history confirm the doc is still current. Action: fix the code.
   - 📜 **doc-stale** — code contradicts the doc, BUT living-truth or git_log shows the discrepancy is **intentional** (a deletion/refactor/migration was logged). Action: update the doc, not the code.
   - ⚠️ **unverifiable** — can't tell from current sandbox (e.g. external dependency).

   To distinguish ❌ from 📜 you MUST do this when the code looks "missing":
   a. grep the living-truth files for the missing thing (e.g. "flows", "BookingHandler"). If you find a deletion/migration entry → 📜 doc-stale.
   b. Run git_log({path: "<the path>"}) or git_log({grep: "<keyword>"}). If commits show deletion/rename → 📜 doc-stale.
   c. Only if both come back empty do you flag ❌ code-fails-doc.

5. propose_task only for ❌ and 📜 outcomes:
   - For ❌: title = "Implement X (per <doc> §Y)", docRef = the audited doc, priority by impact.
   - For 📜: title = "Update <doc> §Y — X was removed/replaced (see <commit-or-living-truth-ref>)", docRef = the audited doc, priority = med, evidence = the git/living-truth quote that proves it.

6. Final summary: \`N findings · X tasks (M code-fails / K doc-stale). Top 3: …\` Keep it one paragraph max.

# Rules
- Skipping step 1 (read_living_truth) is the #1 cause of bullshit reviews. Do it first, every time.
- Don't propose tasks for ✅ passes.
- Don't fabricate evidence. If grep returns 0 hits, say so plainly.
- For READ tools: one at a time, await result. For WRITE tools (propose_task, update_task): batch is fine.

${refTail}`;
}

/**
 * Resolve a user @mention or tool argument to a DocFile in the group.
 * Tries exact name, case-insensitive name, partial match, and absolute path.
 */
export function resolveDocRef(ctx: ChatGroupContext, ref: string): DocFile | null {
  const r = ref.trim();
  if (!r) return null;

  // Absolute path (must be in the allowed doc list)
  const exactByPath = ctx.docs.find((d) => d.absolutePath === r);
  if (exactByPath) return exactByPath;

  const key = r.toLowerCase().replace(/\\/g, '/');
  const byName = ctx.docsByName.get(key);
  if (byName) return byName;

  // Strip extension if present
  const stripped = key.replace(/\.md$/, '');
  const byStripped = ctx.docsByName.get(stripped);
  if (byStripped) return byStripped;

  // Partial: filename contains
  const partial = ctx.docs.find((d) => {
    const stem = d.relPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '').toLowerCase() ?? '';
    return stem.includes(stripped);
  });
  return partial ?? null;
}

export function readDocBody(d: DocFile): string {
  if (!existsSync(d.absolutePath)) return `_(doc no longer exists: ${d.relPath})_`;
  try {
    const content = readFileSync(d.absolutePath, 'utf8');
    // Token budget: 24K chars (~6K tokens). Plenty for most docs.
    if (content.length > 24_000) {
      return content.slice(0, 24_000) + `\n\n…[truncated; original is ${content.length} chars]`;
    }
    return content;
  } catch (e) {
    return `_(read failed: ${(e as Error).message})_`;
  }
}

/**
 * Extract @mentions from a user message and return doc bodies to inject.
 * Returns up to `maxDocs` resolved docs, each with full body, ready to splice
 * into the user message as additional context.
 */
export function expandMentions(
  ctx: ChatGroupContext,
  userMessage: string,
  maxDocs = 5,
): Array<{ ref: string; doc: DocFile; body: string }> {
  const out: Array<{ ref: string; doc: DocFile; body: string }> = [];
  const seen = new Set<string>();
  const mentionRe = /@([A-Za-z0-9_./\\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(userMessage)) !== null && out.length < maxDocs) {
    const ref = m[1] ?? '';
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const doc = resolveDocRef(ctx, ref);
    if (doc) out.push({ ref, doc, body: readDocBody(doc) });
  }
  return out;
}
