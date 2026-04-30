/**
 * Curated guidance for choosing among LLM models. Sent down to the web UI
 * so the user can see strengths/weaknesses + recommended use cases when
 * picking a model in the Chat tab.
 *
 * Match by exact id first, then by prefix (so e.g. `grok-4-fast-reasoning-latest`
 * inherits the `grok-4-fast` guide). Unknown models get a generic fallback so
 * the UI never shows blank info.
 */
const GUIDES = [
    // ---- xAI Grok family ----
    {
        id: 'grok-4',
        family: 'Grok 4',
        tier: 'flagship',
        contextK: 256,
        oneLiner: 'xAI flagship — strongest reasoning and longest context. Use when answer quality matters more than cost.',
        bestFor: [
            'Multi-doc architectural reviews',
            'Spotting contradictions across PRD / TDD / runbooks',
            'Drafting complex doc patches',
            'Long synthesis (whole project audit)',
        ],
        strengths: ['Best reasoning in family', 'Long context (256K+)', 'Handles ambiguous prompts'],
        weaknesses: ['Slowest', 'Most expensive', 'Sometimes over-explains'],
    },
    {
        id: 'grok-4-0709',
        family: 'Grok 4 (July build)',
        tier: 'flagship',
        contextK: 256,
        oneLiner: 'Dated grok-4 snapshot. Behaves like grok-4 — pin this id if you want a stable build that won\'t shift under you.',
        bestFor: ['Same as grok-4', 'Reproducible reviews where build drift is a problem'],
        strengths: ['Stable, dated checkpoint', 'Same flagship quality as grok-4'],
        weaknesses: ['No newer fixes that hit the rolling grok-4 alias', 'Same cost as flagship'],
    },
    {
        id: 'grok-4.20-0309-reasoning',
        family: 'Grok 4.20 (reasoning)',
        tier: 'flagship',
        contextK: 256,
        oneLiner: 'Newer 4.20 generation with reasoning. Use it for the hardest "evaluate / critique / propose change" prompts.',
        bestFor: ['Cross-doc audits', 'Architectural critique', 'Tricky tradeoff questions', 'Diff drafting'],
        strengths: ['Stronger than grok-4 on reasoning benchmarks', 'Long context'],
        weaknesses: ['Slowest tier', 'Most expensive', 'Sometimes over-thinks simple prompts'],
    },
    {
        id: 'grok-4.20-0309-non-reasoning',
        family: 'Grok 4.20 (non-reasoning)',
        tier: 'flagship',
        contextK: 256,
        oneLiner: '4.20 with reasoning off — flagship-tier output speed boosted, but skips deep "why" thinking.',
        bestFor: ['Long writing tasks', 'Reformatting / restructuring docs', 'When you want quality but not chain-of-thought'],
        strengths: ['Faster than the reasoning sibling', 'Same training base'],
        weaknesses: ['Worse at multi-step reasoning', 'Bad pick for evaluation/critique'],
    },
    {
        id: 'grok-4.20-multi-agent-0309',
        family: 'Grok 4.20 multi-agent',
        tier: 'flagship',
        contextK: 256,
        oneLiner: 'Experimental multi-agent variant. Spends more tokens routing internally — use for genuinely hard, multi-step work.',
        bestFor: ['Whole-project audits', 'Complex refactor planning', 'Exhaustive doc review'],
        strengths: ['Tackles harder problems than single-model siblings'],
        weaknesses: ['Highest latency + cost', 'Overkill for plain Q&A'],
    },
    {
        id: 'grok-4-fast-reasoning',
        family: 'Grok 4 Fast (reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Cheap Grok 4 with reasoning still on. Best default for chat-style review and Q&A — quality close to grok-4 at a fraction of the price.',
        bestFor: ['Day-to-day project chat', 'Doc evaluation', '"Where is X handled?"', 'Multi-step questions'],
        strengths: ['Strong reasoning at low cost', 'Fast streaming', 'Good doc comprehension'],
        weaknesses: ['Slightly less depth than grok-4 on hardest prompts'],
    },
    {
        id: 'grok-4-fast-non-reasoning',
        family: 'Grok 4 Fast (non-reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Same model with reasoning off — fastest cheap chat. Great for lookups, bad for "evaluate" or "why" questions.',
        bestFor: ['Doc summaries', 'Glossary / "what does X mean"', 'Quick Q&A', 'Synopsis generation'],
        strengths: ['Very fast', 'Cheap', 'Good extraction'],
        weaknesses: ['Skips reasoning — bad for "why" or critique questions'],
    },
    {
        id: 'grok-4-1-fast-reasoning',
        family: 'Grok 4.1 Fast (reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Refreshed grok-4-fast with reasoning. Use when grok-4-fast-reasoning isn\'t responding well — same price, slight quality bump.',
        bestFor: ['Same as grok-4-fast-reasoning', 'Tricky chat where 4-fast falls short'],
        strengths: ['Newer training', 'Same low cost', 'Reasoning on'],
        weaknesses: ['Still pre-release-ish; behavior may shift'],
    },
    {
        id: 'grok-4-1-fast-non-reasoning',
        family: 'Grok 4.1 Fast (non-reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Refreshed grok-4-fast non-reasoning. Fastest cheap option in the 4.1 line.',
        bestFor: ['Bulk lookups', 'Synopsis generation', 'Quick "what does this doc say"'],
        strengths: ['Very fast', 'Cheap'],
        weaknesses: ['No reasoning — avoid for evaluation tasks'],
    },
    {
        id: 'grok-code-fast-1',
        family: 'Grok Code Fast',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Code-specialised. Use when the chat is mostly about source code or you want diff/patch output that compiles.',
        bestFor: [
            'Reading source files referenced in docs',
            'Generating doc patches as unified diffs',
            'Reasoning about code-doc consistency',
            'Refactor planning',
        ],
        strengths: ['Strong on code semantics', 'Cheap', 'Outputs cleaner diffs'],
        weaknesses: ['Less polished prose than reasoning Groks', 'Output cost slightly higher than fast-reasoning'],
    },
    {
        id: 'grok-4-fast-reasoning',
        family: 'Grok 4 Fast (reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Cheaper Grok 4 with reasoning still on. Excellent default for chat-style review and Q&A.',
        bestFor: ['Day-to-day project chat', 'Doc evaluation', '"Where is X handled?"', 'Multi-step questions'],
        strengths: ['Strong reasoning at low cost', 'Fast streaming', 'Good doc comprehension'],
        weaknesses: ['Slightly less depth than grok-4 on hardest prompts'],
    },
    {
        id: 'grok-4-fast-non-reasoning',
        family: 'Grok 4 Fast (non-reasoning)',
        tier: 'fast',
        contextK: 256,
        oneLiner: 'Same as above but with reasoning off — faster and cheaper for simple lookups.',
        bestFor: ['Doc summaries', 'Glossary / "what does X mean"', 'Quick Q&A', 'Synopsis generation'],
        strengths: ['Very fast', 'Cheap', 'Good extraction'],
        weaknesses: ['Skips reasoning — bad for "why" or "evaluate" questions'],
    },
    {
        id: 'grok-3',
        family: 'Grok 3',
        tier: 'flagship',
        contextK: 131,
        oneLiner: 'Previous flagship. Solid quality, but grok-4-fast-reasoning is usually better and cheaper now.',
        bestFor: ['Same use cases as grok-4-fast-reasoning if grok-4 is unavailable'],
        strengths: ['Mature, well-tested', 'Strong general reasoning'],
        weaknesses: ['Pricier than grok-4-fast for similar quality', 'Older training cutoff'],
    },
    {
        id: 'grok-3-mini',
        family: 'Grok 3 Mini',
        tier: 'small',
        contextK: 131,
        oneLiner: 'Tiny + cheap. Use for batch jobs (synopsis generation, doc classification), not deep reasoning.',
        bestFor: ['Synopsis generation', 'Doc classification', 'Bulk extraction', 'Throwaway questions'],
        strengths: ['Cheapest', 'Fast', 'Reliable for simple tasks'],
        weaknesses: ['Weak on multi-step reasoning', 'Misses nuance', 'Bad at architectural critique'],
    },
    {
        id: 'grok-2',
        family: 'Grok 2',
        tier: 'legacy',
        contextK: 131,
        oneLiner: 'Older generation. Use only if grok-3/grok-4 are unavailable in your account.',
        bestFor: ['Fallback when newer Groks are unavailable'],
        strengths: ['Cheap', 'Stable'],
        weaknesses: ['Outdated', 'Worse reasoning than grok-3'],
    },
    {
        id: 'grok-2-latest',
        family: 'Grok 2 (latest)',
        tier: 'legacy',
        contextK: 131,
        oneLiner: 'Older generation. Use only as a fallback.',
        bestFor: ['Fallback'],
        strengths: ['Cheap'],
        weaknesses: ['Outdated'],
    },
    {
        id: 'grok-beta',
        family: 'Grok beta',
        tier: 'unknown',
        contextK: 131,
        oneLiner: 'Experimental — quality and pricing change without notice.',
        bestFor: ['Experiments', 'Trying upcoming features'],
        strengths: ['Earliest access to new capabilities'],
        weaknesses: ['Unstable behavior', 'Pricing volatile'],
    },
    // ---- OpenAI family (used if user wires OPENAI_API_KEY) ----
    {
        id: 'gpt-4o',
        family: 'GPT-4o',
        tier: 'flagship',
        contextK: 128,
        oneLiner: 'OpenAI flagship multimodal. Strong reasoning and writing, mid-tier price.',
        bestFor: ['Doc review', 'Long-form writing', 'Architectural Q&A'],
        strengths: ['Reliable formatting', 'Solid reasoning', 'Good code understanding'],
        weaknesses: ['Pricier than grok-4-fast', 'Smaller context than Grok 4'],
    },
    {
        id: 'gpt-4o-mini',
        family: 'GPT-4o Mini',
        tier: 'small',
        contextK: 128,
        oneLiner: 'Cheap and fast OpenAI. Great for routine chat where depth isn\'t needed.',
        bestFor: ['Quick lookups', 'Summaries', 'Triage'],
        strengths: ['Cheap', 'Fast', 'Decent quality'],
        weaknesses: ['Misses subtle reasoning', 'Weaker on multi-doc synthesis'],
    },
    {
        id: 'gpt-4-turbo',
        family: 'GPT-4 Turbo',
        tier: 'legacy',
        contextK: 128,
        oneLiner: 'Older flagship. Quality fine; price isn\'t competitive vs gpt-4o.',
        bestFor: ['When gpt-4o isn\'t available'],
        strengths: ['Strong reasoning'],
        weaknesses: ['Expensive vs current options'],
    },
];
const FALLBACK = {
    id: '*',
    family: 'Unknown model',
    tier: 'unknown',
    oneLiner: 'No guide for this model — assume general-purpose. Pick a known model if you can.',
    bestFor: ['General Q&A'],
    strengths: ['Available'],
    weaknesses: ['Unknown behavior — try a small task first'],
};
export function guideFor(modelId) {
    if (!modelId)
        return FALLBACK;
    const exact = GUIDES.find((g) => g.id === modelId);
    if (exact)
        return exact;
    // Prefix match: e.g. "grok-4-fast-reasoning-latest" → grok-4-fast-reasoning.
    const prefixMatches = GUIDES
        .filter((g) => modelId.startsWith(g.id))
        .sort((a, b) => b.id.length - a.id.length);
    if (prefixMatches[0])
        return { ...prefixMatches[0], id: modelId };
    // Family fuzzy: anything containing "grok-4-fast" → grok-4-fast-reasoning.
    if (/grok-?4.*fast.*non/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'grok-4-fast-non-reasoning'), id: modelId };
    if (/grok-?4.*fast/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'grok-4-fast-reasoning'), id: modelId };
    if (/grok-?4/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'grok-4'), id: modelId };
    if (/grok-?3.*mini/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'grok-3-mini'), id: modelId };
    if (/grok-?3/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'grok-3'), id: modelId };
    if (/gpt-?4o.*mini/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'gpt-4o-mini'), id: modelId };
    if (/gpt-?4o/i.test(modelId))
        return { ...GUIDES.find((g) => g.id === 'gpt-4o'), id: modelId };
    return { ...FALLBACK, id: modelId };
}
export function recommendedFor(role) {
    if (role === 'chat')
        return ['grok-4-fast-reasoning', 'grok-4', 'gpt-4o'];
    if (role === 'classify')
        return ['grok-3-mini', 'gpt-4o-mini', 'grok-4-fast-non-reasoning'];
    if (role === 'patch')
        return ['grok-4', 'grok-4-fast-reasoning', 'gpt-4o'];
    return [];
}
//# sourceMappingURL=modelGuides.js.map