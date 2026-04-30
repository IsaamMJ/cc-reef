/**
 * Per-project Action Plan tasks. Stored as JSONL at
 * ~/.cc-reef/knowledge/<group>/tasks.jsonl
 *
 * One line per task. Updates rewrite the whole file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REEF_KNOWLEDGE } from './paths.js';
import { log } from './log.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'high' | 'med' | 'low';

export interface ActionTask {
  id: string;
  group: string;
  title: string;
  description?: string;
  /** Where the task came from. e.g. doc rel-path, "audit:vision-doc", "chat:c-xyz" */
  source?: string;
  /** Optional doc rel path the task is about — used for "propose doc update". */
  docRef?: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** Evidence the model gathered (e.g. grep matches), kept for the patch step. */
  evidence?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function tasksFile(group: string): string {
  const dir = join(REEF_KNOWLEDGE, group.toLowerCase());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'tasks.jsonl');
}

export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function listTasks(group: string): ActionTask[] {
  const p = tasksFile(group);
  if (!existsSync(p)) return [];
  const out: ActionTask[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as ActionTask;
      if (o && o.id && o.title) out.push(o);
    } catch (e) {
      log.warn('tasks: bad line', { err: (e as Error).message });
    }
  }
  return out;
}

function writeAll(group: string, tasks: ActionTask[]): void {
  const p = tasksFile(group);
  writeFileSync(p, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
}

export function createTask(group: string, input: Partial<ActionTask> & { title: string }): ActionTask {
  const now = new Date().toISOString();
  const task: ActionTask = {
    id: input.id ?? newTaskId(),
    group,
    title: input.title.slice(0, 200),
    description: input.description ? input.description.slice(0, 4000) : undefined,
    source: input.source ? input.source.slice(0, 200) : undefined,
    docRef: input.docRef ? input.docRef.slice(0, 400) : undefined,
    priority: (['high', 'med', 'low'].includes(input.priority as string) ? input.priority : 'med') as TaskPriority,
    status: (['todo', 'in_progress', 'done'].includes(input.status as string) ? input.status : 'todo') as TaskStatus,
    evidence: input.evidence ? input.evidence.slice(0, 4000) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const all = listTasks(group);
  all.push(task);
  writeAll(group, all);
  return task;
}

export function updateTask(
  group: string,
  id: string,
  patch: Partial<Pick<ActionTask, 'title' | 'description' | 'priority' | 'status' | 'docRef' | 'evidence'>>,
): ActionTask | null {
  const all = listTasks(group);
  const i = all.findIndex((t) => t.id === id);
  if (i === -1) return null;
  const cur = all[i]!;
  const next: ActionTask = {
    ...cur,
    title: patch.title !== undefined ? patch.title.slice(0, 200) : cur.title,
    description: patch.description !== undefined ? (patch.description ? patch.description.slice(0, 4000) : undefined) : cur.description,
    priority: patch.priority && ['high', 'med', 'low'].includes(patch.priority) ? patch.priority : cur.priority,
    status: patch.status && ['todo', 'in_progress', 'done'].includes(patch.status) ? patch.status : cur.status,
    docRef: patch.docRef !== undefined ? patch.docRef : cur.docRef,
    evidence: patch.evidence !== undefined ? patch.evidence : cur.evidence,
    updatedAt: new Date().toISOString(),
    completedAt: (patch.status === 'done' && cur.status !== 'done')
      ? new Date().toISOString()
      : (patch.status && patch.status !== 'done' ? undefined : cur.completedAt),
  };
  all[i] = next;
  writeAll(group, all);
  return next;
}

export function deleteTask(group: string, id: string): boolean {
  const all = listTasks(group);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAll(group, next);
  return true;
}

export function getTask(group: string, id: string): ActionTask | null {
  return listTasks(group).find((t) => t.id === id) ?? null;
}

export function summariseOpenTasks(group: string, limit = 8): string {
  const open = listTasks(group).filter((t) => t.status !== 'done').slice(0, limit);
  if (open.length === 0) return '_(no open tasks)_';
  return open.map((t) => `- [${t.priority.toUpperCase()}] ${t.title}${t.docRef ? ` (about ${t.docRef})` : ''}`).join('\n');
}
