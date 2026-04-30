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
function tasksFile(group) {
    const dir = join(REEF_KNOWLEDGE, group.toLowerCase());
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'tasks.jsonl');
}
export function newTaskId() {
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
export function listTasks(group) {
    const p = tasksFile(group);
    if (!existsSync(p))
        return [];
    const out = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const o = JSON.parse(t);
            if (o && o.id && o.title)
                out.push(o);
        }
        catch (e) {
            log.warn('tasks: bad line', { err: e.message });
        }
    }
    return out;
}
function writeAll(group, tasks) {
    const p = tasksFile(group);
    writeFileSync(p, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8');
}
export function createTask(group, input) {
    const now = new Date().toISOString();
    const task = {
        id: input.id ?? newTaskId(),
        group,
        title: input.title.slice(0, 200),
        description: input.description ? input.description.slice(0, 4000) : undefined,
        source: input.source ? input.source.slice(0, 200) : undefined,
        docRef: input.docRef ? input.docRef.slice(0, 400) : undefined,
        priority: (['high', 'med', 'low'].includes(input.priority) ? input.priority : 'med'),
        status: (['todo', 'in_progress', 'done'].includes(input.status) ? input.status : 'todo'),
        evidence: input.evidence ? input.evidence.slice(0, 4000) : undefined,
        createdAt: now,
        updatedAt: now,
    };
    const all = listTasks(group);
    all.push(task);
    writeAll(group, all);
    return task;
}
export function updateTask(group, id, patch) {
    const all = listTasks(group);
    const i = all.findIndex((t) => t.id === id);
    if (i === -1)
        return null;
    const cur = all[i];
    const next = {
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
export function deleteTask(group, id) {
    const all = listTasks(group);
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length)
        return false;
    writeAll(group, next);
    return true;
}
export function getTask(group, id) {
    return listTasks(group).find((t) => t.id === id) ?? null;
}
export function summariseOpenTasks(group, limit = 8) {
    const open = listTasks(group).filter((t) => t.status !== 'done').slice(0, limit);
    if (open.length === 0)
        return '_(no open tasks)_';
    return open.map((t) => `- [${t.priority.toUpperCase()}] ${t.title}${t.docRef ? ` (about ${t.docRef})` : ''}`).join('\n');
}
//# sourceMappingURL=tasks.js.map