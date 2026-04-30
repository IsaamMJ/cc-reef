import { log } from './log.js';
const NIM_BASE = process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = process.env.NIM_MODEL ?? 'openai/gpt-oss-120b';
const NIM_TIMEOUT_MS = Number.parseInt(process.env.NIM_TIMEOUT_MS ?? '30000', 10);
export class NimError extends Error {
    status;
    constructor(msg, status) {
        super(msg);
        this.status = status;
    }
}
export function nimAvailable() {
    return !!process.env.NIM_API_KEY;
}
export async function chat(messages, opts = {}) {
    const key = process.env.NIM_API_KEY;
    if (!key)
        throw new NimError('NIM_API_KEY not set');
    const body = {
        model: opts.model ?? DEFAULT_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 256,
        temperature: opts.temperature ?? 0.2,
        stream: false,
    };
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), NIM_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(`${NIM_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    }
    catch (e) {
        if (e.name === 'AbortError') {
            throw new NimError(`NIM request timed out after ${NIM_TIMEOUT_MS}ms`);
        }
        throw e;
    }
    finally {
        clearTimeout(tid);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.error('nim chat failed', { status: res.status, text: text.slice(0, 200) });
        throw new NimError(`NIM ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const data = await res.json();
    const out = data.choices?.[0]?.message?.content ?? '';
    return out.trim();
}
//# sourceMappingURL=nim.js.map