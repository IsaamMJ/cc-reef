import { listProjectFolders } from './projects.js';
import {
  loadConfig,
  saveConfig,
  addGroup,
  linkProject,
  getGroupForProject,
} from './groups.js';
import { log } from './log.js';

/**
 * Tokens that are almost always structural, not product-defining.
 * Dropping them makes the "primary key" of a folder more distinctive.
 */
const STOPWORDS = new Set([
  'users', 'jahir', 'downloads', 'jiitak',
  'next', 'nextjs', 'backend', 'frontend', 'admin',
  'web', 'webapp', 'mobile', 'api', 'flutter',
  'dxb', 'new', 'folder', 'projects', 'main', 'dev',
]);

/**
 * Common suffix fragments attached directly to a product name
 * without a separator (e.g. "riseCraftfrontend" -> "risecraft").
 */
const SUFFIX_TOKENS = [
  'frontend', 'backend', 'admin', 'nextjs',
  'mobile', 'webapp', 'server', 'client',
];

function rawTokens(folder: string): string[] {
  return folder
    .replace(/^[A-Z]--/, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

function stripSuffix(t: string): string {
  for (const suffix of SUFFIX_TOKENS) {
    if (t.endsWith(suffix) && t.length > suffix.length + 3) {
      return t.slice(0, -suffix.length);
    }
  }
  return t;
}

function primaryKey(folder: string): string | null {
  const toks = rawTokens(folder).map(stripSuffix);
  return toks[0] ?? null;
}

/**
 * Cluster folders by shared 4-char prefix on their primary key.
 * Returns Map<canonicalKey, folderNames[]>.
 */
function clusterFolders(folders: string[]): Map<string, string[]> {
  const PREFIX_LEN = 4;
  const clusters = new Map<string, string[]>();

  for (const folder of folders) {
    const key = primaryKey(folder);
    if (!key) continue;

    let match: string | null = null;
    for (const existingKey of clusters.keys()) {
      const p = Math.min(PREFIX_LEN, existingKey.length, key.length);
      if (existingKey.slice(0, p) === key.slice(0, p)) {
        match = existingKey;
        break;
      }
    }

    if (match) {
      clusters.get(match)!.push(folder);
      // Prefer the shorter key as the canonical cluster name — shorter
      // keys tend to be the actual product name, longer ones variants.
      if (key.length < match.length) {
        const members = clusters.get(match)!;
        clusters.delete(match);
        clusters.set(key, members);
      }
    } else {
      clusters.set(key, [folder]);
    }
  }

  return clusters;
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AutoGroupResult {
  totalProjects: number;
  alreadyGrouped: string[];
  created: Array<{ group: string; projects: string[] }>;
  skippedSingletons: string[];
  dryRun: boolean;
}

export function runAutoGroup(
  options: { dryRun?: boolean } = {},
): AutoGroupResult {
  const allProjects = listProjectFolders();
  const cfg = loadConfig();

  const alreadyGrouped: string[] = [];
  const unassigned: string[] = [];
  for (const p of allProjects) {
    if (getGroupForProject(cfg, p)) alreadyGrouped.push(p);
    else unassigned.push(p);
  }

  const clusters = clusterFolders(unassigned);
  const created: Array<{ group: string; projects: string[] }> = [];
  const skippedSingletons: string[] = [];

  // Folders with no primary key (all tokens filtered out) aren't in any
  // cluster — surface them so the caller sees every unassigned folder.
  const clustered = new Set<string>();
  for (const members of clusters.values()) {
    for (const m of members) clustered.add(m);
  }
  for (const f of unassigned) {
    if (!clustered.has(f)) skippedSingletons.push(f);
  }

  for (const [key, members] of clusters) {
    // Only auto-create groups for clusters with 2+ folders. Singletons
    // get listed so the user can decide whether they deserve their own group.
    if (members.length < 2) {
      skippedSingletons.push(...members);
      continue;
    }

    // Disambiguate against existing group names.
    let groupName = titleCase(key);
    let i = 2;
    while (cfg.groups[groupName]) {
      groupName = `${titleCase(key)} ${i++}`;
    }

    if (!options.dryRun) {
      addGroup(cfg, groupName);
      for (const folder of members) linkProject(cfg, folder, groupName);
    }
    created.push({ group: groupName, projects: [...members].sort() });
  }

  if (!options.dryRun) saveConfig(cfg);

  log.info('autogroup', {
    created: created.length,
    singletons: skippedSingletons.length,
    alreadyGrouped: alreadyGrouped.length,
    dryRun: !!options.dryRun,
  });

  return {
    totalProjects: allProjects.length,
    alreadyGrouped,
    created,
    skippedSingletons,
    dryRun: !!options.dryRun,
  };
}
