import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { chat, llmAvailable } from './llm.js';
import { extractClaims as extractInlineClaims, type Claim } from './drift.js';
import { log } from './log.js';

/**
 * LLM-extracted claims with mtime-based cache. Skips the call entirely when
 * the cached entry's docMtime matches the file on disk — so re-running drift
 * checks against unchanged docs costs nothing.
 *
 * Cache shape: ~/.cc-reef/knowledge/<group>/llm-claims.json
 *   { "<absDocPath>": { mtime, extractedAt, claims: [...] } }
 */

interface LLMClaimCacheEntry {
  mtime: number;
  extractedAt: string;
  claims: Claim[];
}

type LLMClaimCache = Record<string, LLMClaimCacheEntry>;

function cachePath(group: string): string {
  return join(REEF_KNOWLEDGE, group.toLowerCase(), 'llm-claims.json');
}

function readCache(group: string): LLMClaimCache {
  const p = cachePath(group);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as LLMClaimCache; } catch { return {}; }
}

function writeCache(group: string, cache: LLMClaimCache): void {
  const p = cachePath(group);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
}

const SYSTEM_PROMPT = `You extract verifiable architectural claims from a TDD/PRD/spec document.

Return ONLY a JSON object:
{ "claims": [ { "description": string, "pattern": string, "scope"?: string, "forbidden"?: boolean } ] }

Rules:
- "pattern" is a JavaScript regex source (no leading/trailing slashes, no flags).
- "scope" is a path prefix where matches ARE allowed; matches outside count as drift. Use forward slashes.
- "forbidden": true means ANY match anywhere is drift (use for forbidden literals/strings).
- Skip vague claims. Only emit claims that grep can mechanically verify.
- Skip claims that would obviously fire on docs/tests/comments.
- Return at most 8 claims per doc.
- If no checkable claims, return { "claims": [] }.`;

export async function extractLlmClaims(
  group: string,
  docAbsPath: string,
  docRelPath: string,
  content: string,
): Promise<Claim[]> {
  if (!llmAvailable()) return [];

  let mtime = 0;
  try { mtime = statSync(docAbsPath).mtimeMs; } catch { /* ignore */ }

  const cache = readCache(group);
  const cached = cache[docAbsPath];
  if (cached && cached.mtime === mtime && Array.isArray(cached.claims)) {
    return cached.claims;
  }

  const trimmed = content.length > 60_000 ? content.slice(0, 60_000) : content;
  let claims: Claim[] = [];
  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Doc path: ${docRelPath}\n\n${trimmed}` },
      ],
      {
        purpose: 'claim_extract',
        responseFormat: 'json_object',
        maxTokens: 1500,
        group,
      },
    );
    const obj = JSON.parse(res.text) as { claims?: Array<Partial<Claim>> };
    let i = 0;
    for (const c of obj.claims ?? []) {
      if (!c.description || !c.pattern) continue;
      claims.push({
        id: `${docRelPath}#llm-${i++}`,
        docPath: docRelPath,
        section: '',
        description: c.description,
        pattern: c.pattern,
        scope: c.scope,
        forbidden: c.forbidden === true,
      });
    }
  } catch (e) {
    log.warn('claimsExtract: LLM call failed', { group, doc: docRelPath, err: (e as Error).message });
    return cached?.claims ?? [];
  }

  cache[docAbsPath] = {
    mtime,
    extractedAt: new Date().toISOString(),
    claims,
  };
  try { writeCache(group, cache); } catch (e) {
    log.warn('claimsExtract: cache write failed', { err: (e as Error).message });
  }

  return claims;
}

export function combineClaims(inline: Claim[], llm: Claim[]): Claim[] {
  // Inline (manual) claims win on duplicates by description+pattern.
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const c of inline) {
    const key = `${c.description}|${c.pattern}|${c.scope ?? ''}`;
    seen.add(key);
    out.push(c);
  }
  for (const c of llm) {
    const key = `${c.description}|${c.pattern}|${c.scope ?? ''}`;
    if (seen.has(key)) continue;
    out.push(c);
  }
  return out;
}

export { extractInlineClaims };
