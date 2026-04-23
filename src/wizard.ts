import { select, input, confirm } from '@inquirer/prompts';
import {
  loadConfig,
  saveConfig,
  listGroupNames,
  addGroup,
  linkProject,
  unlinkProject,
  removeGroup,
  getUnassignedProjects,
  getGroupForProject,
  suggestGroupKey,
  UNGROUPED,
  type ReefConfig,
} from './groups.js';
import { isAbortError } from './errors.js';

export type AssignmentResult = 'skip' | 'skipAll' | { group: string };

function groupChoices(cfg: ReefConfig): Array<{ name: string; value: string }> {
  return listGroupNames(cfg).map((name) => {
    const co = cfg.groups[name]?.company;
    return {
      name: co ? `${name}  (${co})` : name,
      value: `link:${name}`,
    };
  });
}

/**
 * Prompt the user to assign a single project to a group, create a new
 * group, skip this one, or skip all remaining. Persists the result.
 */
export async function promptForGroupAssignment(
  project: string,
): Promise<AssignmentResult> {
  const cfg = loadConfig();
  const suggestion = suggestGroupKey(project);
  const existingNames = listGroupNames(cfg);
  const defaultValue = existingNames.find(
    (n) => n.toLowerCase() === suggestion.toLowerCase(),
  );

  const choice = await select({
    message: `New project folder: ${project}`,
    choices: [
      ...groupChoices(cfg),
      { name: '+ Create new group', value: 'new' },
      { name: 'Skip this one', value: 'skip' },
      { name: 'Skip all remaining', value: 'skipAll' },
    ],
    default: defaultValue ? `link:${defaultValue}` : undefined,
  });

  if (choice === 'skip') return 'skip';
  if (choice === 'skipAll') return 'skipAll';

  if (choice === 'new') {
    const name = await input({
      message: 'New group name:',
      default: suggestion,
      validate: (v) =>
        v.trim().length > 0 ? true : 'Group name cannot be empty',
    });
    const addCompany = await confirm({
      message: 'Add a company name for this group?',
      default: false,
    });
    let company: string | undefined;
    if (addCompany) {
      company = (await input({ message: 'Company name:' })).trim() || undefined;
    }
    const cfg2 = loadConfig();
    if (!cfg2.groups[name]) addGroup(cfg2, name, company);
    linkProject(cfg2, project, name);
    saveConfig(cfg2);
    return { group: name };
  }

  const name = choice.slice('link:'.length);
  const cfg2 = loadConfig();
  linkProject(cfg2, project, name);
  saveConfig(cfg2);
  return { group: name };
}

/**
 * Batch prompt for every currently unassigned project. Returns the number
 * of projects newly assigned. Respects "skip all" — the rest get nothing.
 */
export async function promptForAllUnassigned(
  allProjects: string[],
): Promise<{ assigned: number; skipped: number }> {
  const cfg = loadConfig();
  const unassigned = getUnassignedProjects(cfg, allProjects);
  if (unassigned.length === 0) return { assigned: 0, skipped: 0 };

  console.log(
    `\nFound ${unassigned.length} unassigned project folder(s). ` +
      `You can group them now or skip for later.\n`,
  );

  let assigned = 0;
  let skipped = 0;
  let skipAll = false;

  for (const project of unassigned) {
    if (skipAll) {
      skipped++;
      continue;
    }
    try {
      const result = await promptForGroupAssignment(project);
      if (result === 'skip') skipped++;
      else if (result === 'skipAll') {
        skipAll = true;
        skipped++;
      } else assigned++;
    } catch (e) {
      if (isAbortError(e)) {
        console.log('(prompt cancelled — continuing)');
        skipAll = true;
        skipped++;
      } else {
        throw e;
      }
    }
  }

  return { assigned, skipped };
}

function printGroupings(cfg: ReefConfig, allProjects: string[]): void {
  const names = listGroupNames(cfg);
  if (names.length === 0) {
    console.log('(no groups defined yet)');
  } else {
    for (const name of names) {
      const def = cfg.groups[name]!;
      const co = def.company ? `  (${def.company})` : '';
      console.log(`\n${name}${co}`);
      if (def.projects.length === 0) {
        console.log('  (empty)');
      } else {
        for (const p of def.projects) console.log(`  - ${p}`);
      }
    }
  }
  const unassigned = getUnassignedProjects(cfg, allProjects);
  if (unassigned.length > 0) {
    console.log(`\n${UNGROUPED}`);
    for (const p of unassigned) console.log(`  - ${p}`);
  }
}

async function wizardCreate(): Promise<void> {
  const cfg = loadConfig();
  const name = await input({
    message: 'New group name:',
    validate: (v) => v.trim().length > 0 || 'Group name cannot be empty',
  });
  if (cfg.groups[name]) {
    console.log(`Group "${name}" already exists.`);
    return;
  }
  const addCo = await confirm({ message: 'Add a company?', default: false });
  const company = addCo
    ? ((await input({ message: 'Company name:' })).trim() || undefined)
    : undefined;
  addGroup(cfg, name, company);
  saveConfig(cfg);
  console.log(`Created group "${name}".`);
}

async function wizardLink(allProjects: string[]): Promise<void> {
  const cfg = loadConfig();
  const names = listGroupNames(cfg);
  if (names.length === 0) {
    console.log('No groups exist yet — create one first.');
    return;
  }
  const unassigned = getUnassignedProjects(cfg, allProjects);
  const allChoices = allProjects.map((p) => ({
    name: unassigned.includes(p)
      ? `${p}  [unassigned]`
      : `${p}  [${getGroupForProject(cfg, p)}]`,
    value: p,
  }));
  const project = await select({
    message: 'Which project?',
    choices: allChoices,
  });
  const group = await select({
    message: `Link "${project}" to which group?`,
    choices: names.map((n) => ({ name: n, value: n })),
  });
  linkProject(cfg, project, group);
  saveConfig(cfg);
  console.log(`Linked ${project} -> ${group}.`);
}

async function wizardUnlink(): Promise<void> {
  const cfg = loadConfig();
  const assigned: Array<{ project: string; group: string }> = [];
  for (const [groupName, def] of Object.entries(cfg.groups)) {
    for (const p of def.projects) assigned.push({ project: p, group: groupName });
  }
  if (assigned.length === 0) {
    console.log('No projects are currently linked.');
    return;
  }
  const project = await select({
    message: 'Unlink which project?',
    choices: assigned.map((a) => ({
      name: `${a.project}  [${a.group}]`,
      value: a.project,
    })),
  });
  unlinkProject(cfg, project);
  saveConfig(cfg);
  console.log(`Unlinked ${project}.`);
}

async function wizardDelete(): Promise<void> {
  const cfg = loadConfig();
  const names = listGroupNames(cfg);
  if (names.length === 0) {
    console.log('No groups to delete.');
    return;
  }
  const name = await select({
    message: 'Delete which group?',
    choices: names.map((n) => {
      const def = cfg.groups[n]!;
      return {
        name: `${n}  (${def.projects.length} projects)`,
        value: n,
      };
    }),
  });
  const ok = await confirm({
    message: `Delete "${name}"? (Projects become unassigned, not deleted.)`,
    default: false,
  });
  if (!ok) {
    console.log('Cancelled.');
    return;
  }
  removeGroup(cfg, name);
  saveConfig(cfg);
  console.log(`Deleted group "${name}".`);
}

export async function runGroupsWizard(allProjects: string[]): Promise<void> {
  while (true) {
    const action = await select({
      message: 'Groups — what would you like to do?',
      choices: [
        { name: 'View current groupings', value: 'view' },
        { name: 'Assign unassigned projects', value: 'assignAll' },
        { name: 'Create new group', value: 'create' },
        { name: 'Link project to group', value: 'link' },
        { name: 'Unlink project', value: 'unlink' },
        { name: 'Delete group', value: 'delete' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    try {
      if (action === 'exit') return;
      if (action === 'view') printGroupings(loadConfig(), allProjects);
      else if (action === 'assignAll') {
        const r = await promptForAllUnassigned(allProjects);
        console.log(`Assigned ${r.assigned}, skipped ${r.skipped}.`);
      } else if (action === 'create') await wizardCreate();
      else if (action === 'link') await wizardLink(allProjects);
      else if (action === 'unlink') await wizardUnlink();
      else if (action === 'delete') await wizardDelete();
    } catch (e) {
      if (isAbortError(e)) {
        console.log('(cancelled)');
        return;
      }
      throw e;
    }
    console.log('');
  }
}
