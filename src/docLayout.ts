/**
 * User-defined doc layout per group. Replaces the architectural taxonomy.
 *
 * Persisted on GroupDef.docLayout in ~/.cc-reef/config.json:
 *   {
 *     "groups": [
 *       { "id": "g1", "name": "Vision", "docs": ["E:/.../vision.md"] },
 *       { "id": "g2", "name": "PRDs",   "docs": ["E:/.../prd.md"] },
 *       { "id": "g3", "name": "TDDs",   "docs": [...] }
 *     ]
 *   }
 *
 * Docs not present in any group are returned as `unsorted`, so the user
 * can still see + place them. Stale paths (deleted from disk) are filtered.
 */

import type { DocFile } from './docs.js';

export interface LayoutGroup {
  id: string;
  name: string;
  docs: string[];     // absolute paths in display order
  collapsed?: boolean;
}

export interface DocLayout {
  groups: LayoutGroup[];
}

export interface RenderedLayout {
  groups: Array<{ id: string; name: string; collapsed: boolean; docs: DocFile[] }>;
  unsorted: DocFile[];
}

export function emptyLayout(): DocLayout {
  return { groups: [] };
}

/**
 * Validate + normalise a user-supplied layout. Drops malformed entries.
 * Does NOT add an "Unsorted" group — that's computed dynamically.
 */
export function normaliseLayout(raw: unknown): DocLayout {
  if (!raw || typeof raw !== 'object') return emptyLayout();
  const obj = raw as { groups?: unknown };
  if (!Array.isArray(obj.groups)) return emptyLayout();
  const groups: LayoutGroup[] = [];
  const seenIds = new Set<string>();
  for (const g of obj.groups) {
    if (!g || typeof g !== 'object') continue;
    const gg = g as { id?: unknown; name?: unknown; docs?: unknown; collapsed?: unknown };
    const id = typeof gg.id === 'string' && gg.id ? gg.id : `g-${Math.random().toString(36).slice(2, 8)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const name = typeof gg.name === 'string' ? gg.name.slice(0, 100) : 'Untitled';
    const docs = Array.isArray(gg.docs) ? gg.docs.filter((p) => typeof p === 'string') as string[] : [];
    const collapsed = gg.collapsed === true;
    groups.push({ id, name, docs, collapsed });
  }
  return { groups };
}

/**
 * Apply a layout to a freshly-scanned doc set. Returns groups (with docs
 * resolved + ordered) plus an `unsorted` array for everything not placed.
 * Stale paths in the layout are silently dropped (doc deleted/moved).
 */
export function applyLayout(docs: DocFile[], layout: DocLayout): RenderedLayout {
  const byPath = new Map<string, DocFile>();
  for (const d of docs) byPath.set(d.absolutePath, d);

  const placed = new Set<string>();
  const groups = layout.groups.map((g) => {
    const resolved: DocFile[] = [];
    for (const p of g.docs) {
      const d = byPath.get(p);
      if (d && !placed.has(p)) { resolved.push(d); placed.add(p); }
    }
    return { id: g.id, name: g.name, collapsed: g.collapsed === true, docs: resolved };
  });

  const unsorted = docs
    .filter((d) => !placed.has(d.absolutePath))
    .sort((a, b) => (a.title || a.relPath).localeCompare(b.title || b.relPath));

  return { groups, unsorted };
}

/**
 * Strip stale paths (docs no longer on disk) from a layout. Used before
 * persisting any user-supplied layout so config.json stays clean.
 */
export function pruneLayout(layout: DocLayout, docs: DocFile[]): DocLayout {
  const valid = new Set(docs.map((d) => d.absolutePath));
  return {
    groups: layout.groups.map((g) => ({
      ...g,
      docs: g.docs.filter((p) => valid.has(p)),
    })),
  };
}
