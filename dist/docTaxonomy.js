/**
 * Architectural doc taxonomy — single source of truth for phase 1.
 * Tier 1 = most important (read first). Tier 99 = lateral/uncategorised.
 *
 * type → tier mapping is fixed; never override at runtime.
 */
/**
 * Canonical default order. User may reorder per-group via UI; the
 * customised order lives on the GroupDef as `docOrder: DocType[]`.
 */
export const DEFAULT_TYPE_ORDER = [
    'vision',
    'prd',
    'system-context',
    'architecture',
    'module-tdd',
    'cross-cutting',
    'api-spec',
    'runbook',
    'adr',
    'notes',
];
export const TYPE_LABELS = {
    vision: 'Vision',
    prd: 'PRDs',
    'system-context': 'System context',
    architecture: 'Architecture',
    'module-tdd': 'Module TDDs',
    'cross-cutting': 'Cross-cutting concerns',
    'api-spec': 'API contracts',
    runbook: 'Runbooks & ops',
    adr: 'ADRs',
    notes: 'Notes & backlog',
};
export const TYPE_DESCRIPTIONS = {
    vision: 'North star, mission, charter.',
    prd: 'Product requirements, user stories, acceptance criteria.',
    'system-context': 'System + its users + neighbours (C4 L1).',
    architecture: 'Containers, components, key boundaries (C4 L2-L3).',
    'module-tdd': 'Per-service / per-module deep dives.',
    'cross-cutting': 'Auth, observability, data, AI/RAG, security.',
    'api-spec': 'Interface specs, request/response shapes.',
    runbook: 'Deployment, incident response, oncall.',
    adr: 'Architectural decision records (lateral).',
    notes: 'Scratch notes, backlog, work-in-progress.',
};
export const TIERS = DEFAULT_TYPE_ORDER.map((t, i) => ({
    tier: i + 1,
    label: TYPE_LABELS[t],
    types: [t],
    description: TYPE_DESCRIPTIONS[t],
}));
export const TIER_FOR_TYPE = (() => {
    const m = {};
    DEFAULT_TYPE_ORDER.forEach((t, i) => { m[t] = i + 1; });
    return m;
})();
export const ALL_TYPES = [...DEFAULT_TYPE_ORDER];
/**
 * Validate + normalise a user-supplied order. Unknown types are dropped;
 * missing types are appended in canonical order so every type still has
 * a position.
 */
export function normaliseOrder(order) {
    const seen = new Set();
    const out = [];
    for (const t of order ?? []) {
        if (DEFAULT_TYPE_ORDER.includes(t) && !seen.has(t)) {
            out.push(t);
            seen.add(t);
        }
    }
    for (const t of DEFAULT_TYPE_ORDER)
        if (!seen.has(t))
            out.push(t);
    return out;
}
export function tierForType(type, order) {
    const i = order.indexOf(type);
    return i === -1 ? 99 : i + 1;
}
/**
 * Heuristic classifier — runs when frontmatter is absent.
 * Looks at filename, parent folder, and the first ~400 chars of body.
 * Confidence is low; results are flagged `inferred: true` so phase 2/3
 * never write back over user-authored frontmatter.
 */
export function classifyHeuristic(relPath, body) {
    const path = relPath.toLowerCase().replace(/\\/g, '/');
    const name = path.split('/').pop() ?? '';
    const stem = name.replace(/\.md$/, '');
    const folder = path.split('/').slice(0, -1).join('/');
    const head = body.slice(0, 600).toLowerCase();
    const hits = (re) => re.test(stem) || re.test(folder) || re.test(head);
    if (/\b(vision|north[-\s]?star|charter|mission)\b/i.test(stem))
        return tag('vision', 'medium');
    if (/\b(prd|product[-_\s]?requirements?)\b/i.test(stem) || hits(/product requirements/))
        return tag('prd', 'medium');
    if (/\b(system[-\s]?context|context[-\s]?diagram|c4[-\s]?l1)\b/i.test(stem))
        return tag('system-context', 'medium');
    if (/\b(architecture|system[-\s]?design|tdd|technical[-\s]?design)\b/i.test(stem)) {
        // master-architecture vs module-* — name prefix wins
        if (/\bmodule[-_]/i.test(stem))
            return tag('module-tdd', 'medium');
        return tag('architecture', 'medium');
    }
    if (/\bmodule[-_]/i.test(stem) || /^\d+[-_]module[-_]/.test(stem))
        return tag('module-tdd', 'medium');
    if (/\b(api|endpoint|openapi|swagger|interface[-\s]?spec)\b/i.test(stem))
        return tag('api-spec', 'medium');
    if (/\b(deploy|deployment|runbook|oncall|incident|infra|aws|infrastructure|ops)\b/i.test(stem))
        return tag('runbook', 'medium');
    if (/\b(auth|security|observability|logging|tracing|rag|pipeline|graph[-\s]?intelligence|data[-\s]?model)\b/i.test(stem))
        return tag('cross-cutting', 'medium');
    if (/^adr[-_]/i.test(stem) || folder.endsWith('/adr') || folder.endsWith('/adrs') || folder.endsWith('/decisions'))
        return tag('adr', 'medium');
    // Folder-level fallbacks.
    if (folder.endsWith('/ttd') || folder.endsWith('/tdd'))
        return tag('module-tdd', 'low');
    if (folder.endsWith('/prd') || folder.endsWith('/prds'))
        return tag('prd', 'low');
    if (folder.endsWith('/runbooks'))
        return tag('runbook', 'low');
    return tag('notes', 'low');
}
function tag(type, confidence) {
    return { type, tier: TIER_FOR_TYPE[type], confidence };
}
export function tierLabel(tier) {
    return TIERS.find((t) => t.tier === tier)?.label ?? 'Other';
}
export function tierLabelInOrder(tier, order) {
    const t = order[tier - 1];
    return t ? TYPE_LABELS[t] : 'Other';
}
export function tierDescriptionInOrder(tier, order) {
    const t = order[tier - 1];
    return t ? TYPE_DESCRIPTIONS[t] : '';
}
//# sourceMappingURL=docTaxonomy.js.map