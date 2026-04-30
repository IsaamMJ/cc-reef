import { getDb, closeDb } from './db.js';
import { loadConfig, getGroupForProject, getGroupDisplayName, UNGROUPED } from './groups.js';
import { log } from './log.js';
function sinceIso(opts) {
    if (opts.since) {
        const d = new Date(opts.since);
        const days = Math.max(1, Math.round((Date.now() - d.getTime()) / 86400000));
        return { iso: opts.since, days };
    }
    const days = opts.days ?? 7;
    return { iso: new Date(Date.now() - days * 86400000).toISOString(), days };
}
function fmtTokens(n) {
    if (n < 1000)
        return String(n);
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}
function dayKey(iso) {
    if (!iso)
        return null;
    return iso.slice(0, 10);
}
function longestStreak(days) {
    if (days.size === 0)
        return 0;
    const sorted = [...days].sort();
    let best = 1, cur = 1;
    for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1]).getTime();
        const curr = new Date(sorted[i]).getTime();
        if (curr - prev === 86400000) {
            cur++;
            if (cur > best)
                best = cur;
        }
        else {
            cur = 1;
        }
    }
    return best;
}
export function generateRetro(opts = {}) {
    const { iso: since, days } = sinceIso(opts);
    const cfg = loadConfig();
    const db = getDb();
    const sessions = db
        .prepare(`SELECT session_id, project, started_at, ended_at, turn_count, tool_call_count,
              total_input_tokens, total_output_tokens, total_cache_read_tokens, primary_model
       FROM sessions
       WHERE ended_at IS NOT NULL AND ended_at >= ?`)
        .all(since);
    if (sessions.length === 0) {
        closeDb();
        return [
            `# reef retro — last ${days} days`,
            ``,
            `No completed sessions in this window. Try \`reef retro --days 30\` for a wider lens.`,
            ``,
        ].join('\n');
    }
    const sessionIds = sessions.map((s) => s.session_id);
    const placeholders = sessionIds.map(() => '?').join(',');
    const toolRows = db
        .prepare(`SELECT tool_name, COUNT(*) c FROM tool_calls
       WHERE session_id IN (${placeholders})
       GROUP BY tool_name ORDER BY c DESC`)
        .all(...sessionIds);
    closeDb();
    const totalSessions = sessions.length;
    const totalTurns = sessions.reduce((a, s) => a + s.turn_count, 0);
    const totalToolCalls = sessions.reduce((a, s) => a + s.tool_call_count, 0);
    const totalInput = sessions.reduce((a, s) => a + s.total_input_tokens, 0);
    const totalOutput = sessions.reduce((a, s) => a + s.total_output_tokens, 0);
    const activeDays = new Set();
    for (const s of sessions) {
        const d = dayKey(s.ended_at);
        if (d)
            activeDays.add(d);
    }
    const streak = longestStreak(activeDays);
    // Per-group breakdown.
    const byGroup = new Map();
    for (const s of sessions) {
        const g = getGroupForProject(cfg, s.project) ?? UNGROUPED;
        const row = byGroup.get(g) ?? { sessions: 0, turns: 0, tools: 0 };
        row.sessions++;
        row.turns += s.turn_count;
        row.tools += s.tool_call_count;
        byGroup.set(g, row);
    }
    const sortedGroups = [...byGroup.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
    // Tool patterns.
    const toolMap = new Map(toolRows.map((r) => [r.tool_name, r.c]));
    const bash = toolMap.get('Bash') ?? 0;
    const grep = toolMap.get('Grep') ?? 0;
    const glob = toolMap.get('Glob') ?? 0;
    const read = toolMap.get('Read') ?? 0;
    const native = grep + glob + read;
    const ratio = native === 0 ? Infinity : bash / native;
    // Model usage.
    const modelCount = new Map();
    for (const s of sessions) {
        if (s.primary_model)
            modelCount.set(s.primary_model, (modelCount.get(s.primary_model) ?? 0) + 1);
    }
    const opus = [...modelCount.entries()].filter(([m]) => m.includes('opus')).reduce((a, [, c]) => a + c, 0);
    const haiku = [...modelCount.entries()].filter(([m]) => m.includes('haiku')).reduce((a, [, c]) => a + c, 0);
    const sonnet = [...modelCount.entries()].filter(([m]) => m.includes('sonnet')).reduce((a, [, c]) => a + c, 0);
    // Build coaching narrative.
    const lines = [];
    lines.push(`# reef retro — last ${days} days`);
    lines.push('');
    lines.push(`*A weekly coaching read of how you actually used Claude Code, not just what you shipped.*`);
    lines.push('');
    // ---- The week at a glance ----
    lines.push(`## The week at a glance`);
    lines.push('');
    lines.push(`You ran **${totalSessions} sessions** across **${activeDays.size} active day${activeDays.size === 1 ? '' : 's'}** ` +
        `(longest streak: **${streak} day${streak === 1 ? '' : 's'}**).`);
    lines.push('');
    lines.push(`That's **${totalTurns.toLocaleString()} turns**, **${totalToolCalls.toLocaleString()} tool calls**, ` +
        `**${fmtTokens(totalInput + totalOutput)} tokens** of conversation with the model.`);
    lines.push('');
    // ---- Where the work went ----
    if (sortedGroups.length > 0) {
        lines.push(`## Where the work went`);
        lines.push('');
        const top = sortedGroups[0];
        const topName = top[0] === UNGROUPED ? UNGROUPED : getGroupDisplayName(cfg, top[0]);
        const topShare = (top[1].sessions / totalSessions * 100).toFixed(0);
        lines.push(`Most of your time went to **${topName}** (${top[1].sessions} sessions, ${topShare}% of the week).`);
        if (sortedGroups.length > 1) {
            const others = sortedGroups.slice(1, 4)
                .map(([g, r]) => `${g === UNGROUPED ? UNGROUPED : getGroupDisplayName(cfg, g)} (${r.sessions})`)
                .join(', ');
            lines.push('');
            lines.push(`Then: ${others}.`);
        }
        if (byGroup.has(UNGROUPED)) {
            lines.push('');
            lines.push(`> ⚠ ${byGroup.get(UNGROUPED).sessions} session${byGroup.get(UNGROUPED).sessions === 1 ? '' : 's'} ` +
                `landed in **${UNGROUPED}** — these aren't being tracked against any company. Run \`reef groups\` to label them.`);
        }
        lines.push('');
    }
    // ---- What's working ----
    const wins = [];
    if (ratio < 0.5 && native > 0) {
        wins.push(`You're leaning on native search/read (Grep/Glob/Read = ${native}) over Bash (${bash}). That's the discipline that compounds — each native call is cheaper, faster, and more deterministic than a shell pipe.`);
    }
    if (sonnet > opus + haiku && sonnet > 5) {
        wins.push(`Sonnet is your default (${sonnet} sessions). Good — it's the right balance for most engineering work without burning Opus quota on small tasks.`);
    }
    if (streak >= 5) {
        wins.push(`A ${streak}-day streak shows real momentum. Consistency beats heroics.`);
    }
    if (haiku > 0 && haiku >= sessions.length * 0.1) {
        wins.push(`You're using Haiku for ${haiku} session${haiku === 1 ? '' : 's'} — that means you're matching model size to task. Most people never bother.`);
    }
    if (wins.length > 0) {
        lines.push(`## What's working`);
        lines.push('');
        for (const w of wins)
            lines.push(`- ${w}`);
        lines.push('');
    }
    // ---- What to fix ----
    const fixes = [];
    if (ratio >= 1 && bash > 20) {
        fixes.push(`**Bash is dominating native tools** (${bash} Bash vs ${native} Grep/Glob/Read — ratio ${ratio.toFixed(2)}). ` +
            `Every \`grep\` shell-out is slower and noisier than the Grep tool. Try: when you reach for Bash, ask yourself "is this a search or a read?" If yes, switch.`);
    }
    if (opus > sonnet * 2 && opus > 10) {
        fixes.push(`**Opus is doing work Sonnet could handle** (${opus} Opus vs ${sonnet} Sonnet sessions). ` +
            `Opus is for architecture, deep debugging, and review. For "rename this", "fix this lint error", "add a logging line" — Sonnet is faster and cheaper. You'll feel it in your monthly bill.`);
    }
    const ungroupedCount = byGroup.get(UNGROUPED)?.sessions ?? 0;
    if (ungroupedCount >= 3) {
        fixes.push(`**${ungroupedCount} ungrouped sessions** means your reports lie to you. You can't see "how much time on Jiive vs personal" if half the work isn't labelled. \`reef groups\` takes 30 seconds.`);
    }
    const avgTurns = totalTurns / totalSessions;
    if (avgTurns > 40) {
        fixes.push(`**Sessions are running long** (avg ${avgTurns.toFixed(0)} turns each). Long sessions mean context bloat and the model loses the thread. ` +
            `Consider: when a session crosses 30 turns, finish the current task, commit, and start fresh.`);
    }
    if (fixes.length > 0) {
        lines.push(`## What to fix`);
        lines.push('');
        for (const f of fixes)
            lines.push(`- ${f}`);
        lines.push('');
    }
    // ---- Top tools ----
    lines.push(`## Top tools`);
    lines.push('');
    for (const r of toolRows.slice(0, 8)) {
        const pct = ((r.c / totalToolCalls) * 100).toFixed(0);
        lines.push(`- \`${r.tool_name}\` — ${r.c.toLocaleString()} (${pct}%)`);
    }
    lines.push('');
    // ---- One thing for next week ----
    lines.push(`## One thing for next week`);
    lines.push('');
    let prescription;
    if (ratio >= 1 && bash > 20) {
        prescription = `Cut your Bash-to-native ratio in half. Right now it's ${ratio.toFixed(2)}; aim for under 0.8. ` +
            `Every time you'd run \`grep\`, \`find\`, \`cat\`, \`head\`, \`ls\` — use the dedicated tool instead. Reef will tell you next week if it worked.`;
    }
    else if (opus > sonnet * 2 && opus > 10) {
        prescription = `Default new sessions to Sonnet. Reserve Opus for explicitly hard work (architecture decisions, gnarly bugs, big refactors). ` +
            `If a task feels like it'd take a junior engineer 5 minutes, Sonnet is enough.`;
    }
    else if (ungroupedCount >= 3) {
        prescription = `Run \`reef groups\` and assign every ungrouped folder. It takes 30 seconds and unlocks honest week-over-week comparisons.`;
    }
    else if (activeDays.size <= 2) {
        prescription = `You only worked ${activeDays.size} day${activeDays.size === 1 ? '' : 's'} this window. ` +
            `Either there's nothing to fix here, or your sessions are short and bursty — both are fine, but worth noticing.`;
    }
    else {
        prescription = `Nothing urgent. Your patterns are clean. Use the slack to set a project intent or log a decision in fyi for one of your active groups — that compounds.`;
    }
    lines.push(prescription);
    lines.push('');
    log.info('retro generated', { sessions: totalSessions, days });
    return lines.join('\n');
}
//# sourceMappingURL=retro.js.map