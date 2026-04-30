import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { REEF_HOME } from './paths.js';
const FP_PATH = join(REEF_HOME, 'auto-bug-fingerprints.json');
function readFile() {
    if (!existsSync(FP_PATH))
        return { records: {}, dailyCounter: { day: '', count: 0 } };
    try {
        return JSON.parse(readFileSync(FP_PATH, 'utf8'));
    }
    catch {
        return { records: {}, dailyCounter: { day: '', count: 0 } };
    }
}
function writeFile(f) {
    if (!existsSync(REEF_HOME))
        mkdirSync(REEF_HOME, { recursive: true });
    writeFileSync(FP_PATH, JSON.stringify(f, null, 2), 'utf8');
}
function fingerprint(ctx) {
    // Hash on (source + first stack line + message). This collapses the same
    // bug raised many times into one fingerprint, but lets distinct bugs differ.
    const firstStackLine = (ctx.stack ?? '').split('\n').slice(0, 3).join(' | ');
    const seed = `${ctx.source}::${ctx.message}::${firstStackLine}`;
    return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}
function sanitize(text) {
    if (!text)
        return text;
    const home = homedir();
    const username = userInfo().username;
    let out = text;
    if (home) {
        const homeFwd = home.replace(/\\/g, '/');
        const homeDoubled = home.replace(/\\/g, '\\\\');
        out = out.split(home).join('~');
        out = out.split(homeFwd).join('~');
        out = out.split(homeDoubled).join('~');
    }
    out = out.replace(/C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/"\s]+/gi, '~');
    out = out.replace(/\/Users\/[^/"\s]+/g, '~');
    out = out.replace(/\/home\/[^/"\s]+/g, '~');
    if (username && username.length >= 3) {
        const re = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        out = out.replace(re, '<user>');
    }
    // Scrub Claude project folder mangling (e.g. "E--ClientA-backend").
    out = out.replace(/\b[A-Z]--[A-Za-z0-9][\w-]*/g, '<project>');
    // Scrub UUIDs (likely session IDs).
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
    // Scrub anything that looks like an API key (long ish alnum/dash strings preceded by common prefixes).
    out = out.replace(/\b(xai-|sk-|ghp_|github_pat_|nvapi-)[A-Za-z0-9_-]{16,}/g, '$1<redacted>');
    return out;
}
export function autoReportEnabled() {
    return process.env.REEF_AUTO_REPORT === '1' && !!process.env.GITHUB_TOKEN;
}
async function postIssue(repo, title, body, labels) {
    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'cc-reef-auto-report',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, body, labels }),
    });
    if (!res.ok)
        return null;
    return (await res.json());
}
/**
 * File a structured observation from Claude (or any reviewer). Unlike
 * `autoReport`, this is for things a human/agent NOTICES — not crashes.
 * Still deduped by fingerprint and rate-limited per day. Same sanitiser.
 */
export async function reportObservation(obs) {
    const fp = createHash('sha256').update(`obs::${obs.title}::${obs.description.slice(0, 200)}`).digest('hex').slice(0, 16);
    if (!autoReportEnabled())
        return { reported: false, reason: 'disabled', fingerprint: fp };
    const repo = process.env.REEF_AUTO_REPORT_REPO ?? 'IsaamMJ/cc-reef';
    const baseLabels = (process.env.REEF_AUTO_REPORT_LABELS ?? 'auto-reported,bug')
        .split(',').map((s) => s.trim()).filter(Boolean);
    const labels = [...new Set([...baseLabels, obs.severity ?? 'bug', 'observation'])];
    const dailyCap = Number.parseInt(process.env.REEF_AUTO_REPORT_DAILY_CAP ?? '5', 10);
    const file = readFile();
    const today = new Date().toISOString().slice(0, 10);
    if (file.dailyCounter.day !== today)
        file.dailyCounter = { day: today, count: 0 };
    const existing = file.records[fp];
    const nowIso = new Date().toISOString();
    if (existing) {
        existing.count++;
        existing.lastSeen = nowIso;
        writeFile(file);
        return { reported: false, reason: 'duplicate', fingerprint: fp, issueUrl: existing.issueUrl };
    }
    if (file.dailyCounter.count >= dailyCap) {
        return { reported: false, reason: 'rate_limited', fingerprint: fp };
    }
    const safeDesc = sanitize(obs.description);
    const safeFix = obs.suggestedFix ? sanitize(obs.suggestedFix) : '';
    const safeRefs = (obs.fileRefs ?? []).map((r) => sanitize(r));
    const title = `[obs] ${obs.title.slice(0, 90)}`;
    const body = [
        `## Observation (auto-filed by reviewer)`,
        ``,
        obs.severity ? `**Severity:** \`${obs.severity}\`` : '',
        obs.group ? `**Group:** \`${obs.group}\`` : '',
        `**Fingerprint:** \`${fp}\``,
        ``,
        `## Description`,
        safeDesc,
        safeRefs.length ? `\n## Files referenced\n${safeRefs.map((r) => `- \`${r}\``).join('\n')}` : '',
        safeFix ? `\n## Suggested fix\n${safeFix}` : '',
        ``,
        `<sub>Filed via \`reef_report_observation\`. Paths, usernames, project names, UUIDs, and API keys are scrubbed locally before sending.</sub>`,
    ].filter(Boolean).join('\n');
    const issue = await postIssue(repo, title, body, labels).catch(() => null);
    if (!issue)
        return { reported: false, reason: 'http_error', fingerprint: fp };
    file.records[fp] = {
        count: 1,
        firstSeen: nowIso,
        lastSeen: nowIso,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
    };
    file.dailyCounter.count++;
    writeFile(file);
    return { reported: true, fingerprint: fp, issueUrl: issue.html_url };
}
export async function autoReport(ctx) {
    const fp = fingerprint(ctx);
    if (!autoReportEnabled())
        return { reported: false, reason: 'disabled', fingerprint: fp };
    const repo = process.env.REEF_AUTO_REPORT_REPO ?? 'IsaamMJ/cc-reef';
    const labels = (process.env.REEF_AUTO_REPORT_LABELS ?? 'auto-reported,bug')
        .split(',').map((s) => s.trim()).filter(Boolean);
    const dailyCap = Number.parseInt(process.env.REEF_AUTO_REPORT_DAILY_CAP ?? '5', 10);
    const file = readFile();
    const today = new Date().toISOString().slice(0, 10);
    if (file.dailyCounter.day !== today)
        file.dailyCounter = { day: today, count: 0 };
    const existing = file.records[fp];
    const nowIso = new Date().toISOString();
    if (existing) {
        existing.count++;
        existing.lastSeen = nowIso;
        writeFile(file);
        // Dedupe: same fingerprint already filed → skip new issue.
        return { reported: false, reason: 'duplicate', fingerprint: fp, issueUrl: existing.issueUrl };
    }
    if (file.dailyCounter.count >= dailyCap) {
        return { reported: false, reason: 'rate_limited', fingerprint: fp };
    }
    const safeMessage = sanitize(ctx.message);
    const safeStack = ctx.stack ? sanitize(ctx.stack) : '';
    const safeExtra = ctx.extra ? sanitize(JSON.stringify(ctx.extra, null, 2)) : '';
    const title = `[auto] ${ctx.source}: ${safeMessage.slice(0, 80)}`;
    const body = [
        `## Auto-reported reef error`,
        ``,
        `**Source:** \`${ctx.source}\``,
        `**Fingerprint:** \`${fp}\``,
        `**First seen:** ${nowIso}`,
        ``,
        `## Message`,
        '```',
        safeMessage,
        '```',
        safeStack ? `## Stack\n\`\`\`\n${safeStack}\n\`\`\`` : '',
        safeExtra ? `## Context\n\`\`\`\n${safeExtra}\n\`\`\`` : '',
        ``,
        `## Environment`,
        `- platform: ${process.platform} ${process.arch}`,
        `- node: ${process.version}`,
        ``,
        `<sub>Filed by reef auto-report. Paths, usernames, project names, UUIDs, and API keys are scrubbed locally before sending.</sub>`,
    ].filter(Boolean).join('\n');
    const issue = await postIssue(repo, title, body, labels).catch(() => null);
    if (!issue) {
        return { reported: false, reason: 'http_error', fingerprint: fp };
    }
    file.records[fp] = {
        count: 1,
        firstSeen: nowIso,
        lastSeen: nowIso,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
    };
    file.dailyCounter.count++;
    writeFile(file);
    return { reported: true, fingerprint: fp, issueUrl: issue.html_url };
}
//# sourceMappingURL=autoReport.js.map