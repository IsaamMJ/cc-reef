import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { chat, llmAvailable } from './llm.js';
import { scanGroupRepoDocs, resolveProjectPath } from './docs.js';
import { log } from './log.js';

/**
 * For a logged decision, ask the LLM to propose a doc patch:
 *  - Pick the most relevant TDD/PRD section across the group's scanned docs.
 *  - Suggest a replacement (full new section text + the original snippet to replace).
 *
 * Patches sit pending in `pending-patches.json`. User reviews diff in web UI
 * and clicks ✓ to apply (we write the file). NEVER auto-apply.
 */

export interface PendingPatch {
  id: string;
  decisionId: string;
  decisionTitle: string;
  proposedAt: string;
  docAbsPath: string;
  docRelPath: string;
  section: string;
  rationale: string;
  beforeText: string;
  afterText: string;
  status: 'pending' | 'applied' | 'rejected';
}

interface PendingPatchFile {
  patches: PendingPatch[];
}

function pendingPath(group: string): string {
  return join(REEF_KNOWLEDGE, group.toLowerCase(), 'pending-patches.json');
}

export function readPendingPatches(group: string): PendingPatch[] {
  const p = pendingPath(group);
  if (!existsSync(p)) return [];
  try {
    const f = JSON.parse(readFileSync(p, 'utf8')) as PendingPatchFile;
    return f.patches ?? [];
  } catch {
    return [];
  }
}

function writePendingPatches(group: string, patches: PendingPatch[]): void {
  const p = pendingPath(group);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ patches }, null, 2), 'utf8');
}

const SYSTEM_PROMPT = `You update technical design docs to reflect a new architectural decision.

Given:
  - A decision (title, why, impact, refs)
  - A list of candidate doc sections from the project's TDD/PRD/specs

Pick AT MOST ONE section that should be updated. Return ONLY a JSON object:
{
  "shouldPatch": boolean,
  "docPath": string,           // exact docPath from the candidates
  "section": string,           // exact heading text from the candidates
  "rationale": string,         // 1 sentence: why this section
  "beforeText": string,        // exact substring from the section to replace (verbatim)
  "afterText": string          // replacement text
}

Rules:
- If no section is a good fit, return { "shouldPatch": false }.
- "beforeText" MUST appear verbatim in the section's body. Keep it short and unambiguous (a paragraph or bullet line).
- "afterText" is the replacement. Markdown allowed.
- Don't fabricate sections that don't exist.
- Don't propose patches for vague decisions.`;

interface DecisionForPatch {
  id: string;
  title: string;
  why?: string;
  impact?: string;
  refs?: string[];
}

interface DocSection {
  docPath: string;
  docAbsPath: string;
  section: string;
  body: string;
}

function splitIntoSections(docPath: string, docAbsPath: string, content: string): DocSection[] {
  const lines = content.split('\n');
  const sections: DocSection[] = [];
  let currentHeading = '(intro)';
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (buf.length) sections.push({ docPath, docAbsPath, section: currentHeading, body: buf.join('\n').trim() });
      currentHeading = m[2]!.trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) sections.push({ docPath, docAbsPath, section: currentHeading, body: buf.join('\n').trim() });
  return sections.filter((s) => s.body.length > 30);
}

export async function proposeDocPatch(
  group: string,
  projects: string[],
  decision: DecisionForPatch,
  docPaths: string[] = [],
): Promise<PendingPatch | null> {
  if (!llmAvailable()) return null;

  const docs = scanGroupRepoDocs(projects, docPaths);
  if (docs.length === 0) return null;

  const allSections: DocSection[] = [];
  for (const doc of docs) {
    let content: string;
    try { content = readFileSync(doc.absolutePath, 'utf8'); } catch { continue; }
    allSections.push(...splitIntoSections(doc.relPath, doc.absolutePath, content));
  }
  if (allSections.length === 0) return null;

  // Cap context size: take first 30 sections, truncate body to 800 chars each.
  const candidates = allSections.slice(0, 30).map((s) => ({
    docPath: s.docPath,
    section: s.section,
    body: s.body.length > 800 ? s.body.slice(0, 800) + '\n…' : s.body,
  }));

  const userMsg = [
    `Decision to reflect:`,
    `  title: ${decision.title}`,
    `  why: ${decision.why ?? ''}`,
    `  impact: ${decision.impact ?? ''}`,
    `  refs: ${(decision.refs ?? []).join(', ')}`,
    ``,
    `Candidate sections:`,
    JSON.stringify(candidates, null, 2),
  ].join('\n');

  let parsed: {
    shouldPatch?: boolean;
    docPath?: string;
    section?: string;
    rationale?: string;
    beforeText?: string;
    afterText?: string;
  };
  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      {
        purpose: 'doc_patch',
        responseFormat: 'json_object',
        maxTokens: 1500,
        group,
      },
    );
    parsed = JSON.parse(res.text);
  } catch (e) {
    log.warn('docPatch: LLM call failed', { err: (e as Error).message });
    return null;
  }

  if (!parsed.shouldPatch || !parsed.docPath || !parsed.beforeText || !parsed.afterText) return null;

  // Find the matching doc to resolve the absolute path.
  const matched = allSections.find((s) => s.docPath === parsed.docPath && s.section === parsed.section);
  if (!matched) {
    log.warn('docPatch: LLM picked a section not in candidates', { picked: parsed.section });
    return null;
  }

  // Verify beforeText actually exists in the doc — else the patch is unappliable.
  let docContent: string;
  try { docContent = readFileSync(matched.docAbsPath, 'utf8'); } catch { return null; }
  if (!docContent.includes(parsed.beforeText)) {
    log.warn('docPatch: beforeText not found verbatim, skipping', { docPath: parsed.docPath });
    return null;
  }

  const patch: PendingPatch = {
    id: `${decision.id}-${Date.now().toString(36)}`,
    decisionId: decision.id,
    decisionTitle: decision.title,
    proposedAt: new Date().toISOString(),
    docAbsPath: matched.docAbsPath,
    docRelPath: matched.docPath,
    section: matched.section,
    rationale: parsed.rationale ?? '',
    beforeText: parsed.beforeText,
    afterText: parsed.afterText,
    status: 'pending',
  };

  const existing = readPendingPatches(group);
  writePendingPatches(group, [...existing, patch]);
  return patch;
}

export function applyPatch(group: string, patchId: string): { ok: true } | { ok: false; error: string } {
  const all = readPendingPatches(group);
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { ok: false, error: 'patch not found' };
  if (patch.status !== 'pending') return { ok: false, error: `patch already ${patch.status}` };

  let content: string;
  try { content = readFileSync(patch.docAbsPath, 'utf8'); } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}` };
  }
  if (!content.includes(patch.beforeText)) {
    return { ok: false, error: 'beforeText no longer present (doc has changed since proposal)' };
  }
  const updated = content.replace(patch.beforeText, patch.afterText);
  try { writeFileSync(patch.docAbsPath, updated, 'utf8'); } catch (e) {
    return { ok: false, error: `write failed: ${(e as Error).message}` };
  }
  patch.status = 'applied';
  writePendingPatches(group, all);
  return { ok: true };
}

export function rejectPatch(group: string, patchId: string): boolean {
  const all = readPendingPatches(group);
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return false;
  patch.status = 'rejected';
  writePendingPatches(group, all);
  return true;
}

// Also export resolveProjectPath wiring for tests.
export { resolveProjectPath };
