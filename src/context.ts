import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, readdirSync, appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { REEF_COMPANIES, REEF_KNOWLEDGE } from './paths.js';

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ---- Company Context ----

export function companyDir(company: string): string {
  return join(REEF_COMPANIES, company);
}

export function getCompanyContextPath(company: string): string {
  return join(companyDir(company), 'context.md');
}

export function readCompanyContext(company: string): string | null {
  const p = getCompanyContextPath(company);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

export function writeCompanyContext(company: string, content: string): void {
  ensureDir(companyDir(company));
  writeFileSync(getCompanyContextPath(company), content, 'utf8');
}

// ---- Project Knowledge ----

export function projectDir(groupKey: string): string {
  return join(REEF_KNOWLEDGE, groupKey.toLowerCase());
}

export function getProjectIntentPath(groupKey: string): string {
  return join(projectDir(groupKey), 'intent.md');
}

export function getFyiPath(groupKey: string): string {
  return join(projectDir(groupKey), 'fyi.md');
}

export function getDecisionsDir(groupKey: string): string {
  return join(projectDir(groupKey), 'decisions');
}

export function readProjectIntent(groupKey: string): string | null {
  const p = getProjectIntentPath(groupKey);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

export function writeProjectIntent(groupKey: string, content: string): void {
  ensureDir(projectDir(groupKey));
  writeFileSync(getProjectIntentPath(groupKey), content, 'utf8');
}

export function readFyiRecent(groupKey: string, maxEntries = 10): string | null {
  const p = getFyiPath(groupKey);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n');
  // Each entry starts with '## ' — find the last maxEntries blocks
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.slice(-maxEntries).join('\n\n') || null;
}

export function appendFyiEntry(groupKey: string, entry: string): void {
  ensureDir(projectDir(groupKey));
  const p = getFyiPath(groupKey);
  const date = new Date().toISOString().slice(0, 10);
  const block = `\n## ${date}\n${entry.trim()}\n`;
  appendFileSync(p, block, 'utf8');
}

export function createAdr(
  groupKey: string,
  title: string,
  context: string,
  decision: string,
  consequences: string,
): string {
  const dir = getDecisionsDir(groupKey);
  ensureDir(dir);
  const existing = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')) : [];
  const num = String(existing.length + 1).padStart(3, '0');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const filename = `${num}-${slug}.md`;
  const date = new Date().toISOString().slice(0, 10);
  const content = [
    `# ADR ${num}: ${title}`,
    ``,
    `**Date:** ${date}  `,
    `**Status:** Accepted`,
    ``,
    `## Context`,
    ``,
    context.trim(),
    ``,
    `## Decision`,
    ``,
    decision.trim(),
    ``,
    `## Consequences`,
    ``,
    consequences.trim(),
    ``,
  ].join('\n');
  writeFileSync(join(dir, filename), content, 'utf8');
  return filename;
}

export function listAdrs(groupKey: string): string[] {
  const dir = getDecisionsDir(groupKey);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort();
}

// ---- Combined context for reef_get_context ----

export interface ProjectContext {
  company: string | null;
  companyContext: string | null;
  groupKey: string;
  displayName: string;
  intent: string | null;
  recentDecisions: string | null;
  adrCount: number;
}

export function buildProjectContext(
  groupKey: string,
  displayName: string,
  company: string | null,
): ProjectContext {
  return {
    company,
    companyContext: company ? readCompanyContext(company) : null,
    groupKey,
    displayName,
    intent: readProjectIntent(groupKey),
    recentDecisions: readFyiRecent(groupKey, 10),
    adrCount: listAdrs(groupKey).length,
  };
}
