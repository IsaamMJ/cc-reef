/**
 * Tiny YAML-subset frontmatter parser. Zero deps.
 * Supports the shapes we use in reef:
 *   key: value
 *   key: "quoted value"
 *   key: [a, b, c]
 *   key:
 *     - a
 *     - b
 * Anything more exotic is ignored — phase 1 frontmatter is intentionally flat.
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;        // doc body with frontmatter stripped
  raw: string;         // exact frontmatter block including fences (or '' if none)
  hasFrontmatter: boolean;
}

const FENCE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/;

export function parseFrontmatter(content: string): Frontmatter {
  const m = content.match(FENCE);
  if (!m) return { data: {}, body: content, raw: '', hasFrontmatter: false };
  const inner = m[1] ?? '';
  const data = parseYamlSubset(inner);
  return {
    data,
    body: content.slice(m[0].length),
    raw: m[0],
    hasFrontmatter: true,
  };
}

function parseYamlSubset(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1]!;
    const rawVal = (m[2] ?? '').trim();
    if (rawVal === '') {
      // Possible nested list on subsequent lines.
      const list: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const sub = lines[j] ?? '';
        const sm = sub.match(/^\s+-\s+(.+)$/);
        if (!sm) break;
        list.push(stripQuotes(sm[1]!.trim()));
        j++;
      }
      out[key] = list;
      i = j;
    } else {
      out[key] = parseScalar(rawVal);
      i++;
    }
  }
  return out;
}

function parseScalar(v: string): unknown {
  // Inline list: [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => stripQuotes(p.trim()));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return stripQuotes(v);
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Render a frontmatter block from a flat object. Used by the "stamp" action.
 * Order of keys is preserved.
 */
export function renderFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => String(x));
      lines.push(`${k}: [${items.map(quoteIfNeeded).join(', ')}]`);
    } else if (typeof v === 'string') {
      lines.push(`${k}: ${quoteIfNeeded(v)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(v: string): string {
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(v) || /\s$/.test(v) || /^\s/.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}
