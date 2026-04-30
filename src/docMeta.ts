/**
 * LLM-backed enrichment for DocFiles, with mtime cache so we only pay once
 * per doc revision. Read-only — never writes to .md files. Stamping is a
 * separate, human-approved action in server.ts.
 *
 * Cache lives at ~/.cc-reef/knowledge/<group>/doc-meta.json
 *   { "<absPath>": { mtime, type, tier, status, synopsis, references, model } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readFileSync as rf } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { chat, llmAvailable } from './llm.js';
import { ALL_TYPES, TIER_FOR_TYPE, type DocType } from './docTaxonomy.js';
import { parseFrontmatter } from './frontmatter.js';
import { log } from './log.js';

export interface DocMetaEntry {
  mtime: number;
  type: DocType;
  tier: number;
  status?: string;
  synopsis?: string;
  references?: string[];
  model?: string;
  enrichedAt: string;
}

interface DocMetaFile {
  entries: Record<string, DocMetaEntry>;
}

function metaPath(group: string): string {
  return join(REEF_KNOWLEDGE, group.toLowerCase(), 'doc-meta.json');
}

export function readDocMeta(group: string): Record<string, DocMetaEntry> {
  const p = metaPath(group);
  if (!existsSync(p)) return {};
  try {
    const f = JSON.parse(readFileSync(p, 'utf8')) as DocMetaFile;
    return f.entries ?? {};
  } catch {
    return {};
  }
}

function writeDocMeta(group: string, entries: Record<string, DocMetaEntry>): void {
  const p = metaPath(group);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ entries }, null, 2), 'utf8');
}

const SYSTEM_PROMPT = `You classify a markdown architectural document.

Return ONLY a JSON object, no prose:
{
  "type": one of [${ALL_TYPES.map((t) => `"${t}"`).join(', ')}],
  "status": "draft" | "active" | "deprecated" | "unknown",
  "synopsis": one sentence, max 140 chars, what THIS doc covers (not the project),
  "references": array of strings — other doc filenames or module/component names this doc depends on or mentions
}

Type definitions:
- vision: product north star, mission, charter
- prd: product requirements document, user stories, acceptance criteria
- system-context: the system + its users + external systems (C4 L1)
- architecture: containers, components, key boundaries (C4 L2-L3) — system-wide
- module-tdd: per-module / per-service technical design (C4 L3-L4)
- cross-cutting: auth, observability, data layer, AI/RAG, security — concerns spanning modules
- api-spec: HTTP/RPC interface specs, OpenAPI, endpoint catalogues
- runbook: deployment state, oncall, incident response, infra
- adr: architectural decision record (single decision, dated)
- notes: anything else — backlog, scratch, work-in-progress

Rules:
- Pick the SINGLE best type. If a doc covers multiple, pick the dominant one.
- synopsis must describe THIS document specifically, not paraphrase the title.
- references: extract module/service names mentioned (e.g. "payments", "thyrocare", "lumi"), and any explicit doc filenames.`;

interface LlmDocResponse {
  type?: string;
  status?: string;
  synopsis?: string;
  references?: string[];
}

/**
 * Enrich a single doc. Returns cached entry if mtime matches, else calls LLM.
 * Bails silently (returns null) when LLM is unavailable.
 */
export async function enrichDoc(
  group: string,
  absPath: string,
  mtime: number,
): Promise<DocMetaEntry | null> {
  if (!llmAvailable()) return null;

  const cache = readDocMeta(group);
  const cached = cache[absPath];
  if (cached && cached.mtime === mtime) return cached;

  let content: string;
  try { content = rf(absPath, 'utf8'); } catch { return null; }
  const fm = parseFrontmatter(content);
  // Skip if user has explicit frontmatter — they're authoritative.
  if (fm.hasFrontmatter && typeof fm.data.type === 'string' && fm.data.type) {
    return null;
  }

  const body = fm.body.length > 12_000 ? fm.body.slice(0, 12_000) + '\n…[truncated]' : fm.body;
  const userMsg = `File: ${absPath}\n\n${body}`;

  let parsed: LlmDocResponse;
  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      { purpose: 'doc_classify', responseFormat: 'json_object', maxTokens: 500, group },
    );
    parsed = JSON.parse(res.text) as LlmDocResponse;
  } catch (e) {
    log.warn('docMeta: llm classify failed', { absPath, err: (e as Error).message });
    return null;
  }

  const type = (parsed.type && parsed.type in TIER_FOR_TYPE ? parsed.type : 'notes') as DocType;
  const entry: DocMetaEntry = {
    mtime,
    type,
    tier: TIER_FOR_TYPE[type],
    status: typeof parsed.status === 'string' ? parsed.status : undefined,
    synopsis: typeof parsed.synopsis === 'string' ? parsed.synopsis.slice(0, 200) : undefined,
    references: Array.isArray(parsed.references) ? parsed.references.map(String).slice(0, 20) : undefined,
    enrichedAt: new Date().toISOString(),
  };
  cache[absPath] = entry;
  try { writeDocMeta(group, cache); } catch { /* swallow */ }
  return entry;
}

/**
 * Enrich a batch in parallel (capped). Returns the up-to-date cache. Safe to
 * call repeatedly — entries with matching mtime are no-ops.
 */
export async function enrichDocs(
  group: string,
  docs: Array<{ absolutePath: string; mtime: number }>,
  concurrency = 3,
): Promise<Record<string, DocMetaEntry>> {
  if (!llmAvailable()) return readDocMeta(group);
  const queue = [...docs];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) return;
        try { await enrichDoc(group, next.absolutePath, next.mtime); }
        catch (e) { log.warn('docMeta: enrich error', { err: (e as Error).message }); }
      }
    })());
  }
  await Promise.all(workers);
  return readDocMeta(group);
}
