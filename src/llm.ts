import { getDb } from './db.js';
import { log } from './log.js';

/**
 * Pluggable LLM provider layer. Default order: xAI → NIM → OpenAI.
 * The first provider with credentials wins. Every call is logged to the
 * `llm_calls` table with token counts and estimated USD cost.
 *
 * Override the provider explicitly via opts.provider or env REEF_LLM_PROVIDER.
 */

export type ProviderName = 'xai' | 'nim' | 'openai';

export type CallPurpose =
  | 'claim_extract'      // pull TDD claims out of a markdown doc
  | 'drift_check'        // does this diff violate any claim?
  | 'decision_suggest'   // propose decisions from a session diff
  | 'doc_patch'          // generate a doc patch for a decision
  | 'doc_classify'       // classify a doc into the architectural taxonomy
  | 'embed'              // semantic search embedding
  | 'chat'               // user-facing project chat
  | 'other';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  provider?: ProviderName;
  purpose?: CallPurpose;
  responseFormat?: 'json_object' | 'text';
  group?: string;
  project?: string;
}

export interface ChatResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class LLMError extends Error {
  constructor(msg: string, public status?: number, public provider?: ProviderName) {
    super(msg);
  }
}

// USD per million tokens. Rough public-list values; override via env if needed.
// Keys are exact model strings. Fallback uses provider defaults.
interface ProviderPricing {
  defaultModel: string;
  prices: Record<string, { input: number; output: number }>;
  fallback: { input: number; output: number };
}

const PRICING: Record<ProviderName, ProviderPricing> = {
  xai: {
    defaultModel: process.env.XAI_MODEL ?? 'grok-3-mini',
    prices: {
      // grok-4 family
      'grok-4': { input: 3.0, output: 15.0 },
      'grok-4-0709': { input: 3.0, output: 15.0 },
      'grok-4-fast-reasoning': { input: 0.20, output: 0.50 },
      'grok-4-fast-non-reasoning': { input: 0.20, output: 0.50 },
      'grok-4-1-fast-reasoning': { input: 0.20, output: 0.50 },
      'grok-4-1-fast-non-reasoning': { input: 0.20, output: 0.50 },
      'grok-4.20-0309-reasoning': { input: 3.0, output: 15.0 },
      'grok-4.20-0309-non-reasoning': { input: 3.0, output: 15.0 },
      'grok-4.20-multi-agent-0309': { input: 5.0, output: 25.0 },
      // grok-3 family
      'grok-3': { input: 3.0, output: 15.0 },
      'grok-3-mini': { input: 0.30, output: 0.50 },
      // code-specialized
      'grok-code-fast-1': { input: 0.20, output: 1.50 },
      // legacy
      'grok-2': { input: 2.0, output: 10.0 },
      'grok-2-latest': { input: 2.0, output: 10.0 },
      'grok-beta': { input: 5.0, output: 15.0 },
    },
    fallback: { input: 1.0, output: 5.0 },
  },
  nim: {
    defaultModel: process.env.NIM_MODEL ?? 'openai/gpt-oss-120b',
    prices: {},
    fallback: { input: 0.0, output: 0.0 }, // NIM dev tier is free for now
  },
  openai: {
    defaultModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    prices: {
      'gpt-4o': { input: 2.5, output: 10.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4-turbo': { input: 10.0, output: 30.0 },
    },
    fallback: { input: 1.0, output: 3.0 },
  },
};

function estimateCost(provider: ProviderName, model: string, input: number, output: number): number {
  const cfg = PRICING[provider];
  const p = cfg.prices[model] ?? cfg.fallback;
  return (input * p.input + output * p.output) / 1_000_000;
}

function pickProvider(explicit?: ProviderName): ProviderName | null {
  const order: ProviderName[] = explicit
    ? [explicit]
    : ((process.env.REEF_LLM_PROVIDER as ProviderName) ? [process.env.REEF_LLM_PROVIDER as ProviderName] : ['xai', 'nim', 'openai']);
  for (const p of order) {
    if (p === 'xai' && process.env.XAI_API_KEY) return 'xai';
    if (p === 'nim' && process.env.NIM_API_KEY) return 'nim';
    if (p === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  }
  return null;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

function getProviderConfig(p: ProviderName): ProviderConfig {
  if (p === 'xai') {
    return {
      baseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
      apiKey: process.env.XAI_API_KEY ?? '',
    };
  }
  if (p === 'nim') {
    return {
      baseUrl: process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NIM_API_KEY ?? '',
    };
  }
  return {
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY ?? '',
  };
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.REEF_LLM_TIMEOUT_MS ?? '30000', 10);

export function llmAvailable(): boolean {
  return pickProvider() !== null;
}

export function getActiveProvider(): ProviderName | null {
  return pickProvider();
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const provider = pickProvider(opts.provider);
  if (!provider) throw new LLMError('No LLM provider configured. Set XAI_API_KEY, NIM_API_KEY, or OPENAI_API_KEY.');

  const cfg = getProviderConfig(provider);
  const pricing = PRICING[provider];
  const model = opts.model ?? pricing.defaultModel;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    if ((e as Error).name === 'AbortError') {
      throw new LLMError(`${provider} request timed out after ${DEFAULT_TIMEOUT_MS}ms`, undefined, provider);
    }
    throw new LLMError(`${provider} fetch failed: ${(e as Error).message}`, undefined, provider);
  }
  clearTimeout(tid);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LLMError(`${provider} ${res.status}: ${text.slice(0, 300)}`, res.status, provider);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? '';
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const costUsd = estimateCost(provider, model, inputTokens, outputTokens);

  recordCall({
    startedAt,
    provider,
    model,
    purpose: opts.purpose ?? 'other',
    inputTokens,
    outputTokens,
    costUsd,
    group: opts.group ?? null,
    project: opts.project ?? null,
  });

  return { text: text.trim(), provider, model, inputTokens, outputTokens, costUsd };
}

export interface StreamEvent {
  type: 'delta' | 'done' | 'error';
  text?: string;
  finalText?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  provider?: ProviderName;
  model?: string;
  error?: string;
}

/**
 * Streaming chat. Yields incremental text deltas, then a final 'done' event
 * with token counts and cost. The whole thing is logged to llm_calls on
 * 'done', same shape as the non-streaming `chat`.
 *
 * Stream timeout = REEF_CHAT_TIMEOUT_MS (default 120s) — more lenient than
 * the non-streaming default since chat replies can be long.
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const provider = pickProvider(opts.provider);
  if (!provider) {
    yield { type: 'error', error: 'No LLM provider configured. Set XAI_API_KEY, NIM_API_KEY, or OPENAI_API_KEY.' };
    return;
  }

  const cfg = getProviderConfig(provider);
  const pricing = PRICING[provider];
  const model = opts.model ?? pricing.defaultModel;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.4,
    stream: true,
  };
  if (opts.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const timeoutMs = Number.parseInt(process.env.REEF_CHAT_TIMEOUT_MS ?? '120000', 10);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    yield { type: 'error', error: `${provider} fetch failed: ${(e as Error).message}` };
    return;
  }
  if (!res.ok || !res.body) {
    clearTimeout(tid);
    const text = await res.text().catch(() => '');
    yield { type: 'error', error: `${provider} ${res.status}: ${text.slice(0, 300)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames end with \n\n.
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          let obj: { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try { obj = JSON.parse(data); } catch { continue; }
          const delta = obj.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            finalText += delta;
            yield { type: 'delta', text: delta };
          }
          if (obj.usage) {
            inputTokens = obj.usage.prompt_tokens ?? inputTokens;
            outputTokens = obj.usage.completion_tokens ?? outputTokens;
          }
        }
      }
    }
  } catch (e) {
    clearTimeout(tid);
    yield { type: 'error', error: `stream read failed: ${(e as Error).message}` };
    return;
  }
  clearTimeout(tid);

  // xAI/OpenAI usually only include usage on the last frame; if missing,
  // estimate from output length so cost tracking isn't completely broken.
  if (outputTokens === 0 && finalText) outputTokens = Math.max(1, Math.ceil(finalText.length / 4));
  if (inputTokens === 0) {
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
    inputTokens = Math.max(1, Math.ceil(totalChars / 4));
  }
  const costUsd = estimateCost(provider, model, inputTokens, outputTokens);
  recordCall({
    startedAt,
    provider,
    model,
    purpose: opts.purpose ?? 'chat',
    inputTokens,
    outputTokens,
    costUsd,
    group: opts.group ?? null,
    project: opts.project ?? null,
  });

  yield {
    type: 'done',
    finalText,
    inputTokens,
    outputTokens,
    costUsd,
    provider,
    model,
  };
}

export interface ProviderModelInfo {
  id: string;
  provider: ProviderName;
  inputUsdPerM?: number;
  outputUsdPerM?: number;
}

/**
 * Discover available models from the active provider. Tries `GET /v1/models`;
 * if the call fails (no creds, network), returns the hardcoded pricing keys.
 * Always includes the provider's default model so the dropdown is never empty.
 */
export async function listModels(provider?: ProviderName): Promise<ProviderModelInfo[]> {
  const p = pickProvider(provider);
  if (!p) return [];
  const cfg = getProviderConfig(p);
  const pricing = PRICING[p];
  const known = Object.entries(pricing.prices).map(([id, price]) => ({
    id, provider: p, inputUsdPerM: price.input, outputUsdPerM: price.output,
  }));

  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      const NON_CHAT = /(imagine|image|vision|video|audio|tts|whisper|embedding|embed|dall-?e|sora)/i;
      const ids = (j.data ?? [])
        .map((m) => m.id)
        .filter((x): x is string => typeof x === 'string')
        .filter((id) => !NON_CHAT.test(id));
      if (ids.length > 0) {
        const seen = new Set<string>();
        const merged: ProviderModelInfo[] = [];
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const price = pricing.prices[id];
          merged.push({ id, provider: p, inputUsdPerM: price?.input, outputUsdPerM: price?.output });
        }
        // Ensure default + any priced models are present even if API omitted them.
        for (const k of known) if (!seen.has(k.id)) { merged.push(k); seen.add(k.id); }
        if (!seen.has(pricing.defaultModel)) merged.unshift({ id: pricing.defaultModel, provider: p });
        return merged;
      }
    }
  } catch (e) {
    log.warn('llm: model discovery failed', { provider: p, err: (e as Error).message });
  }
  // Fallback to hardcoded list.
  if (known.length === 0) return [{ id: pricing.defaultModel, provider: p }];
  return known;
}

export function getDefaultModel(provider?: ProviderName): string {
  const p = pickProvider(provider);
  if (!p) return '';
  return PRICING[p].defaultModel;
}

interface LlmCallRecord {
  startedAt: string;
  provider: ProviderName;
  model: string;
  purpose: CallPurpose;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  group: string | null;
  project: string | null;
}

function recordCall(rec: LlmCallRecord): void {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      "group" TEXT,
      project TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_calls_started ON llm_calls(started_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose ON llm_calls(purpose)`);

    db.prepare(
      `INSERT INTO llm_calls (started_at, provider, model, purpose, input_tokens, output_tokens, cost_usd, "group", project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.startedAt,
      rec.provider,
      rec.model,
      rec.purpose,
      rec.inputTokens,
      rec.outputTokens,
      rec.costUsd,
      rec.group,
      rec.project,
    );
  } catch (e) {
    log.warn('llm: could not record call', { err: (e as Error).message });
  }
}

export interface SpendSummary {
  totalUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Array<{ provider: string; calls: number; usd: number }>;
  byPurpose: Array<{ purpose: string; calls: number; usd: number }>;
  byModel: Array<{ model: string; calls: number; usd: number }>;
  byDay: Array<{ day: string; calls: number; usd: number }>;
  recent: Array<{
    startedAt: string;
    provider: string;
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    group: string | null;
  }>;
}

export function getSpendSummary(days = 30): SpendSummary {
  const db = getDb();
  // Make sure table exists (no llm calls yet => empty summary).
  db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    "group" TEXT,
    project TEXT
  )`);

  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const totals = db
    .prepare(`SELECT COUNT(*) c, COALESCE(SUM(cost_usd),0) usd, COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(output_tokens),0) out
              FROM llm_calls WHERE started_at >= ?`)
    .get(since) as { c: number; usd: number; inp: number; out: number };

  const byProvider = db
    .prepare(`SELECT provider, COUNT(*) calls, SUM(cost_usd) usd FROM llm_calls
              WHERE started_at >= ? GROUP BY provider ORDER BY usd DESC`)
    .all(since) as Array<{ provider: string; calls: number; usd: number }>;

  const byPurpose = db
    .prepare(`SELECT purpose, COUNT(*) calls, SUM(cost_usd) usd FROM llm_calls
              WHERE started_at >= ? GROUP BY purpose ORDER BY usd DESC`)
    .all(since) as Array<{ purpose: string; calls: number; usd: number }>;

  const byModel = db
    .prepare(`SELECT model, COUNT(*) calls, SUM(cost_usd) usd FROM llm_calls
              WHERE started_at >= ? GROUP BY model ORDER BY usd DESC`)
    .all(since) as Array<{ model: string; calls: number; usd: number }>;

  const byDay = db
    .prepare(`SELECT substr(started_at, 1, 10) day, COUNT(*) calls, SUM(cost_usd) usd
              FROM llm_calls WHERE started_at >= ? GROUP BY day ORDER BY day`)
    .all(since) as Array<{ day: string; calls: number; usd: number }>;

  const recent = db
    .prepare(`SELECT started_at startedAt, provider, model, purpose, input_tokens inputTokens,
                     output_tokens outputTokens, cost_usd costUsd, "group" "group"
              FROM llm_calls ORDER BY started_at DESC LIMIT 50`)
    .all() as SpendSummary['recent'];

  return {
    totalUsd: totals.usd ?? 0,
    totalCalls: totals.c ?? 0,
    totalInputTokens: totals.inp ?? 0,
    totalOutputTokens: totals.out ?? 0,
    byProvider,
    byPurpose,
    byModel,
    byDay,
    recent,
  };
}
