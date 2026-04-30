/**
 * Per-group chat sessions, persisted as JSONL.
 *
 * Storage: ~/.cc-reef/knowledge/<group>/chats/<sessionId>.jsonl
 *   line 1: {"kind":"meta", id, group, title, model, createdAt, updatedAt}
 *   line N: {"kind":"msg", role, content, ts, model?, costUsd?, inputTokens?, outputTokens?}
 *
 * Each project (group) has its own chats folder. Lumi's chats can never see
 * Pearl's docs and vice versa — isolation comes from the group key.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { log } from './log.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  content: string;
  ts: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Optional: doc absolute paths the model was given context for on this turn.
   * Useful for the UI to show "this turn loaded these docs" without re-deriving.
   */
  contextDocs?: string[];
}

export interface ChatSessionMeta {
  id: string;
  group: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Optional per-session system prompt override. When set, replaces the default. */
  systemPrompt?: string;
  /**
   * Which preset (if any) the override came from: 'architect' | 'audit' | 'custom'.
   * Used by the UI to show a refresh banner so users can re-pull the preset
   * when reef-chat's tools/rules evolve.
   */
  presetName?: string;
  /** ISO timestamp when the override was last set. */
  presetSetAt?: string;
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatTurn[];
}

function chatsDir(group: string): string {
  return join(REEF_KNOWLEDGE, group.toLowerCase(), 'chats');
}

function sessionPath(group: string, id: string): string {
  return join(chatsDir(group), `${id}.jsonl`);
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function newSessionId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function listSessions(group: string): ChatSessionMeta[] {
  const dir = chatsDir(group);
  if (!existsSync(dir)) return [];
  const out: ChatSessionMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const first = readFileSync(join(dir, f), 'utf8').split('\n').find((l) => l.trim());
      if (!first) continue;
      const meta = JSON.parse(first) as { kind?: string } & ChatSessionMeta;
      if (meta.kind !== 'meta') continue;
      out.push({
        id: meta.id,
        group: meta.group,
        title: meta.title,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        systemPrompt: meta.systemPrompt,
        presetName: meta.presetName,
        presetSetAt: meta.presetSetAt,
      });
    } catch (e) {
      log.warn('chat: bad session file', { file: f, err: (e as Error).message });
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getSession(group: string, id: string): ChatSession | null {
  const p = sessionPath(group, id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  let meta: ChatSessionMeta | null = null;
  const messages: ChatTurn[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { kind?: string } & Partial<ChatSessionMeta> & Partial<ChatTurn>;
      if (o.kind === 'meta') {
        meta = {
          id: o.id ?? id,
          group: o.group ?? group,
          title: o.title ?? 'Untitled',
          model: o.model ?? '',
          createdAt: o.createdAt ?? new Date().toISOString(),
          updatedAt: o.updatedAt ?? new Date().toISOString(),
          systemPrompt: o.systemPrompt,
          presetName: o.presetName,
          presetSetAt: o.presetSetAt,
        };
      } else if (o.kind === 'msg' && o.role && typeof o.content === 'string') {
        messages.push({
          role: o.role as ChatRole,
          content: o.content,
          ts: o.ts ?? new Date().toISOString(),
          model: o.model,
          costUsd: o.costUsd,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          contextDocs: o.contextDocs,
        });
      }
    } catch {
      log.warn('chat: bad line in session', { id });
    }
  }
  if (!meta) return null;
  return { ...meta, messages };
}

export function createSession(group: string, model: string, title = 'New chat'): ChatSession {
  ensureDir(chatsDir(group));
  const id = newSessionId();
  const now = new Date().toISOString();
  const meta: ChatSessionMeta = { id, group, title, model, createdAt: now, updatedAt: now };
  writeFileSync(sessionPath(group, id), JSON.stringify({ kind: 'meta', ...meta }) + '\n', 'utf8');
  return { ...meta, messages: [] };
}

export function deleteSession(group: string, id: string): boolean {
  const p = sessionPath(group, id);
  if (!existsSync(p)) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

export function appendMessage(group: string, id: string, msg: ChatTurn): void {
  const p = sessionPath(group, id);
  if (!existsSync(p)) {
    log.warn('chat: append to missing session', { id });
    return;
  }
  appendFileSync(p, JSON.stringify({ kind: 'msg', ...msg }) + '\n', 'utf8');
  // Also bump updatedAt by rewriting the meta line.
  touchSession(group, id, {});
}

/**
 * Update meta fields (title, model, updatedAt). Done by reading + rewriting
 * the file with a fresh meta line + the original message lines.
 */
export function touchSession(
  group: string,
  id: string,
  patch: Partial<Pick<ChatSessionMeta, 'title' | 'model' | 'systemPrompt' | 'presetName'>>,
): ChatSessionMeta | null {
  const p = sessionPath(group, id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return null;
  let meta: ChatSessionMeta | null = null;
  const rest: string[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as { kind?: string } & Partial<ChatSessionMeta>;
      if (o.kind === 'meta' && !meta) {
        // systemPrompt: empty string clears, undefined leaves as-is.
        const nextPrompt = patch.systemPrompt !== undefined
          ? (patch.systemPrompt.trim() ? patch.systemPrompt : undefined)
          : o.systemPrompt;
        // presetName: cleared whenever systemPrompt is cleared; otherwise honour patch.
        const promptCleared = patch.systemPrompt !== undefined && !patch.systemPrompt.trim();
        const nextPreset = promptCleared
          ? undefined
          : (patch.presetName !== undefined ? (patch.presetName || undefined) : o.presetName);
        const presetChanged = patch.presetName !== undefined || patch.systemPrompt !== undefined;
        meta = {
          id: o.id ?? id,
          group: o.group ?? group,
          title: patch.title ?? o.title ?? 'Untitled',
          model: patch.model ?? o.model ?? '',
          createdAt: o.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          systemPrompt: nextPrompt,
          presetName: nextPreset,
          presetSetAt: presetChanged ? new Date().toISOString() : o.presetSetAt,
        };
      } else {
        rest.push(line);
      }
    } catch {
      rest.push(line);
    }
  }
  if (!meta) return null;
  writeFileSync(p, [JSON.stringify({ kind: 'meta', ...meta }), ...rest].join('\n') + '\n', 'utf8');
  return meta;
}

/**
 * Auto-derive a title from the first user message if the session is still
 * called "New chat". First line, first 60 chars.
 */
export function autoTitleIfDefault(group: string, id: string, firstUserMsg: string): void {
  const meta = listSessions(group).find((s) => s.id === id);
  if (!meta) return;
  if (meta.title && meta.title !== 'New chat' && meta.title !== 'Untitled') return;
  const cleaned = firstUserMsg.replace(/\s+/g, ' ').trim();
  const title = cleaned.slice(0, 60) + (cleaned.length > 60 ? '…' : '');
  if (title) touchSession(group, id, { title });
}

export function sessionAgeDays(s: ChatSessionMeta): number {
  try {
    return (Date.now() - new Date(s.updatedAt).getTime()) / 86_400_000;
  } catch {
    return 0;
  }
}

export function sessionFileSize(group: string, id: string): number {
  try { return statSync(sessionPath(group, id)).size; } catch { return 0; }
}

// Re-export for callers that don't want to import paths.
export { dirname };
