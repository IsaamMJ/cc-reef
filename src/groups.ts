import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { REEF_CONFIG, REEF_HOME } from './paths.js';
import { ConfigError } from './errors.js';
import { log } from './log.js';

export type TrustTier = 'read-write' | 'read-only' | 'deny';

export interface GroupDef {
  company?: string;
  displayName?: string;
  trust?: TrustTier;
  projects: string[];
  /**
   * Extra absolute paths to scan for docs (PRD, TDD, specs, etc.) on top of
   * the per-project repos in `projects`. Useful when docs live outside any
   * scanned project repo — a sibling docs repo, a shared `/docs` folder,
   * or a monorepo nested doc tree.
   */
  docPaths?: string[];
  /**
   * User-defined doc layout: a list of named groups, each containing an
   * ordered list of doc absolute paths. Replaces the architectural
   * taxonomy. Docs not in any group are surfaced as "unsorted".
   */
  docLayout?: {
    groups: Array<{
      id: string;
      name: string;
      docs: string[];
      collapsed?: boolean;
    }>;
  };
}

export function getGroupTrust(cfg: ReefConfig, name: string): TrustTier {
  const g = cfg.groups[name];
  if (!g) return 'read-write';
  return g.trust ?? 'read-write';
}

export function setGroupTrust(
  cfg: ReefConfig,
  name: string,
  trust: TrustTier,
): ReefConfig {
  const g = cfg.groups[name];
  if (!g) throw new ConfigError(`Group "${name}" not found`, REEF_CONFIG);
  g.trust = trust;
  return cfg;
}

export interface ReefConfig {
  version: 1;
  groups: Record<string, GroupDef>;
}

export const UNGROUPED = '(ungrouped)';

function emptyConfig(): ReefConfig {
  return { version: 1, groups: {} };
}

function ensureHome(): void {
  if (!existsSync(REEF_HOME)) mkdirSync(REEF_HOME, { recursive: true });
}

export function loadConfig(): ReefConfig {
  if (!existsSync(REEF_CONFIG)) return emptyConfig();
  try {
    const raw = readFileSync(REEF_CONFIG, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReefConfig>;
    if (!parsed || typeof parsed !== 'object' || !parsed.groups) {
      throw new ConfigError('config missing "groups"', REEF_CONFIG);
    }
    return { version: 1, groups: parsed.groups };
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(
      `Failed to parse config: ${(e as Error).message}`,
      REEF_CONFIG,
    );
  }
}

export function saveConfig(cfg: ReefConfig): void {
  ensureHome();
  const dir = dirname(REEF_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename, so a crash mid-write can't corrupt config.
  const tmp = REEF_CONFIG + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  renameSync(tmp, REEF_CONFIG);
  log.info('config saved', { groups: Object.keys(cfg.groups).length });
}

export function getGroupForProject(
  cfg: ReefConfig,
  project: string,
): string | null {
  for (const [name, def] of Object.entries(cfg.groups)) {
    if (def.projects.includes(project)) return name;
  }
  return null;
}

export function listGroupNames(cfg: ReefConfig): string[] {
  return Object.keys(cfg.groups).sort();
}

export function addGroup(
  cfg: ReefConfig,
  name: string,
  company?: string,
): ReefConfig {
  if (cfg.groups[name]) {
    throw new ConfigError(`Group "${name}" already exists`, REEF_CONFIG);
  }
  cfg.groups[name] = { projects: [], ...(company ? { company } : {}) };
  return cfg;
}

export function removeGroup(cfg: ReefConfig, name: string): ReefConfig {
  if (!cfg.groups[name]) {
    throw new ConfigError(`Group "${name}" not found`, REEF_CONFIG);
  }
  delete cfg.groups[name];
  return cfg;
}

export function linkProject(
  cfg: ReefConfig,
  project: string,
  groupName: string,
): ReefConfig {
  const group = cfg.groups[groupName];
  if (!group) {
    throw new ConfigError(`Group "${groupName}" not found`, REEF_CONFIG);
  }
  // Remove from any other group first — a project belongs to exactly one group.
  for (const def of Object.values(cfg.groups)) {
    def.projects = def.projects.filter((p) => p !== project);
  }
  if (!group.projects.includes(project)) group.projects.push(project);
  group.projects.sort();
  return cfg;
}

export function unlinkProject(cfg: ReefConfig, project: string): ReefConfig {
  for (const def of Object.values(cfg.groups)) {
    def.projects = def.projects.filter((p) => p !== project);
  }
  return cfg;
}

export function renameGroup(
  cfg: ReefConfig,
  oldName: string,
  newName: string,
): ReefConfig {
  if (!cfg.groups[oldName]) {
    throw new ConfigError(`Group "${oldName}" not found`, REEF_CONFIG);
  }
  if (oldName === newName) return cfg;
  if (cfg.groups[newName]) {
    throw new ConfigError(`Group "${newName}" already exists`, REEF_CONFIG);
  }
  cfg.groups[newName] = cfg.groups[oldName]!;
  delete cfg.groups[oldName];
  return cfg;
}

export function mergeGroups(
  cfg: ReefConfig,
  sourceName: string,
  targetName: string,
): ReefConfig {
  if (sourceName === targetName) return cfg;
  const source = cfg.groups[sourceName];
  const target = cfg.groups[targetName];
  if (!source) {
    throw new ConfigError(`Source group "${sourceName}" not found`, REEF_CONFIG);
  }
  if (!target) {
    throw new ConfigError(`Target group "${targetName}" not found`, REEF_CONFIG);
  }
  for (const p of source.projects) {
    if (!target.projects.includes(p)) target.projects.push(p);
  }
  target.projects.sort();
  delete cfg.groups[sourceName];
  return cfg;
}

export function setGroupCompany(
  cfg: ReefConfig,
  name: string,
  company: string | undefined,
): ReefConfig {
  const g = cfg.groups[name];
  if (!g) throw new ConfigError(`Group "${name}" not found`, REEF_CONFIG);
  if (company && company.trim()) g.company = company.trim();
  else delete g.company;
  return cfg;
}

export function setGroupDisplayName(
  cfg: ReefConfig,
  name: string,
  displayName: string | undefined,
): ReefConfig {
  const g = cfg.groups[name];
  if (!g) throw new ConfigError(`Group "${name}" not found`, REEF_CONFIG);
  if (displayName && displayName.trim()) g.displayName = displayName.trim();
  else delete g.displayName;
  return cfg;
}

export function getGroupDisplayName(cfg: ReefConfig, name: string): string {
  const g = cfg.groups[name];
  if (!g) return name;
  return g.displayName || name;
}

export function getUnassignedProjects(
  cfg: ReefConfig,
  allProjects: string[],
): string[] {
  const assigned = new Set<string>();
  for (const def of Object.values(cfg.groups)) {
    for (const p of def.projects) assigned.add(p);
  }
  return allProjects.filter((p) => !assigned.has(p)).sort();
}

/**
 * Cheap similarity heuristic so "groups init" can pre-suggest groupings.
 * We strip the `X--` drive prefix, lowercase, split on non-alphanumerics,
 * and share tokens. Two projects match if they share at least one
 * non-trivial token (length >= 3).
 */
export function suggestGroupKey(project: string): string {
  const cleaned = project.replace(/^[A-Z]--/, '').toLowerCase();
  const tokens = cleaned.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return tokens[0] ?? cleaned;
}
