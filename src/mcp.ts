import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getStatus } from './status.js';
import { generateReport } from './report.js';
import { generateRetro } from './retro.js';
import { scan } from './scan.js';
import { closeDb, getDb } from './db.js';
import {
  loadConfig,
  saveConfig,
  addGroup as addGroupData,
  linkProject,
  unlinkProject,
  renameGroup,
  mergeGroups,
  setGroupCompany,
  setGroupDisplayName,
  getGroupForProject,
  getUnassignedProjects,
  listGroupNames,
  getGroupTrust,
  UNGROUPED,
} from './groups.js';
import { runAutoGroup } from './autoGroup.js';
import { listProjectFolders } from './projects.js';
import { log } from './log.js';
import { formatError } from './formatError.js';
import { autoReport, reportObservation, autoReportEnabled } from './autoReport.js';
import { buildProjectContext } from './context.js';
import { appendDecision, scanGroupRepoDocs, readDecisions } from './docs.js';
import { REEF_COMPANIES, REEF_KNOWLEDGE } from './paths.js';

const TOOLS: Tool[] = [
  {
    name: 'reef_status',
    description:
      'Report reef health: whether hooks are installed, DB freshness, ' +
      'number of tracked sessions and tool calls, groups configured, and ' +
      'how many CC project folders remain unassigned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reef_report',
    description:
      'Generate a markdown activity report grouped by company/product. ' +
      'Defaults to the last 7 days. Use this to answer "how was my week?" ' +
      'or "what did I spend on RiseCraft last month?"',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Look back N days (default 7). Ignored if `since` is set.',
        },
        since: {
          type: 'string',
          description: 'ISO timestamp. Overrides `days` if provided.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reef_retro',
    description:
      'Generate a coaching-style weekly retro: wins, patterns to fix, and one concrete prescription for next week. ' +
      'Use this when the user asks "how am I doing?", "what should I improve?", "weekly review", ' +
      '"coaching", or "retro". Different from reef_report — this is opinionated and conversational, not a data dump.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Look back N days (default 7).',
        },
        since: {
          type: 'string',
          description: 'ISO timestamp. Overrides `days` if provided.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reef_resume',
    description:
      'Get a concise "where did I leave off" card for a given project ' +
      'folder. Use the Claude Code project folder name (e.g. "E--CCIsaam") ' +
      'which you can find via reef_list_projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Claude Code project folder name (e.g. "E--CCIsaam").',
        },
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_list_projects',
    description:
      'List every Claude Code project folder under ~/.claude/projects/ along ' +
      'with its assigned group (or "(ungrouped)").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reef_list_groups',
    description:
      'List all groups (companies/products) with their members and any ' +
      'associated company name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reef_create_group',
    description:
      'Create a new group. Use this to represent a company or product ' +
      '(e.g. "RiseCraft"). Optionally attach a company name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name (required).' },
        company: { type: 'string', description: 'Company name (optional).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_assign_group',
    description:
      'Assign a Claude Code project folder to a group. The project is ' +
      'removed from any other group it previously belonged to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project folder name.' },
        group: { type: 'string', description: 'Target group name.' },
      },
      required: ['project', 'group'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_unassign',
    description: 'Remove a project folder from whatever group it currently belongs to.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project folder name.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_autogroup',
    description:
      'Automatically group unassigned project folders by name similarity. ' +
      'Strips common prefixes/suffixes, ignores structural tokens like ' +
      '"backend" or "nextjs", and clusters folders that share a 4-char ' +
      'prefix. Only clusters with 2+ members become groups — singletons ' +
      'stay ungrouped. Returns a diff showing what was created and which ' +
      'folders were left alone so the caller can rename, merge, or assign ' +
      'them manually via reef_rename_group / reef_merge_groups / reef_assign_group.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Compute what would change without writing config.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reef_rename_group',
    description: 'Rename an existing group. Useful after reef_autogroup picks a generic name.',
    inputSchema: {
      type: 'object',
      properties: {
        oldName: { type: 'string' },
        newName: { type: 'string' },
      },
      required: ['oldName', 'newName'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_merge_groups',
    description:
      'Merge source group into target group: all source folders move to ' +
      'the target, and the source group is deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source group name (will be deleted).' },
        target: { type: 'string', description: 'Target group name (receives the folders).' },
      },
      required: ['source', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_set_company',
    description: 'Set or clear the company label on an existing group. Pass empty string to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string' },
        company: { type: 'string' },
      },
      required: ['group', 'company'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_update_group_display_name',
    description: 'Update the friendly display name for a group. This is the name shown in reports, status line, and resume cards. Pass empty string to clear and use the group key as the display name.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group key (internal identifier).' },
        displayName: { type: 'string', description: 'New display name, or empty string to clear.' },
      },
      required: ['group', 'displayName'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_scan',
    description:
      'Run an incremental scan of Claude Code transcripts. Normally ' +
      'unnecessary — the Stop hook auto-scans after every session — but ' +
      'useful to force a refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Rescan all files even if unchanged.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reef_get_context',
    description:
      'Get company and project context: what the company does, project vision/intent, ' +
      'and recent decisions/pivots. PULL-BASED — only call when you need to understand ' +
      'the company domain, project goals, or past decisions. Zero tokens if not called.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group key (from reef_list_groups).' },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_log_decision',
    description:
      'Auto-log a significant technical or architectural decision made during this session. ' +
      'Call this PROACTIVELY and AUTOMATICALLY whenever a significant decision, pivot, or ' +
      'trade-off is made — choosing a library, changing architecture, dropping a feature, ' +
      'selecting an approach. Do NOT wait to be asked. Prefer the structured form ' +
      '(title/why/impact/refs); keep each field one short sentence.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group key (from reef_list_groups).' },
        title: { type: 'string', description: 'Short headline for the decision (e.g. "Switch booking storage to JSONL").' },
        why: { type: 'string', description: 'Motivation — the problem, constraint, or trigger.' },
        impact: { type: 'string', description: 'What changes as a result. Files, modules, or behaviour affected.' },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional pointers — file paths, commit shas, or doc sections referenced.',
        },
        project: { type: 'string', description: 'Optional project folder name this decision is scoped to.' },
        decision: {
          type: 'string',
          description: 'Legacy free-form alternative to title/why/impact. Use only if the structured fields do not fit.',
        },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    name: 'reef_report_observation',
    description:
      'File a GitHub issue on the reef repo for a bug, smell, or improvement YOU notice while reviewing reef\'s OWN code or behaviour. ' +
      'Use this when you spot a defect, a missing safety check, a docs issue, a perf concern, or a UX problem in reef itself. ' +
      'Do NOT use this for issues in the user\'s OTHER projects — only for reef. ' +
      'Concise title and a clear description. Add fileRefs and a suggestedFix when possible. ' +
      'Sensitive details (paths, usernames, keys) are sanitised before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short headline. ~80 chars max.' },
        description: { type: 'string', description: 'What is wrong, where, and why it matters.' },
        severity: {
          type: 'string',
          enum: ['bug', 'enhancement', 'docs', 'security', 'performance'],
          description: 'Best-fit category. Defaults to "bug".',
        },
        fileRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant file paths in the reef repo (e.g. src/drift.ts).',
        },
        suggestedFix: { type: 'string', description: 'Optional. One paragraph proposing a fix.' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
  },
];

function ok(json: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(json, null, 2) }],
  };
}

function errResponse(msg: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: msg }],
    isError: true,
  };
}

async function handleCall(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  const a = args ?? {};
  try {
    switch (name) {
      case 'reef_status': {
        const s = getStatus();
        return ok(s);
      }

      case 'reef_report': {
        const md = generateReport({
          days: typeof a.days === 'number' ? a.days : undefined,
          since: typeof a.since === 'string' ? a.since : undefined,
        });
        return { content: [{ type: 'text', text: md }] };
      }

      case 'reef_retro': {
        const md = generateRetro({
          days: typeof a.days === 'number' ? a.days : undefined,
          since: typeof a.since === 'string' ? a.since : undefined,
        });
        return { content: [{ type: 'text', text: md }] };
      }

      case 'reef_list_projects': {
        const cfg = loadConfig();
        const projects = listProjectFolders().map((project) => {
          const groupKey = getGroupForProject(cfg, project);
          return {
            project,
            group: groupKey ?? UNGROUPED,
            displayName: groupKey ? (cfg.groups[groupKey]?.displayName ?? groupKey) : UNGROUPED,
          };
        });
        return ok({ count: projects.length, projects });
      }

      case 'reef_list_groups': {
        const cfg = loadConfig();
        const groups = listGroupNames(cfg).map((name) => {
          const def = cfg.groups[name]!;
          const company = def.company ?? null;
          return {
            name,
            displayName: def.displayName ?? name,
            company,
            projects: def.projects ?? [],
            hasCompanyContext: company ? existsSync(join(REEF_COMPANIES, company, 'context.md')) : false,
            hasIntent: existsSync(join(REEF_KNOWLEDGE, name.toLowerCase(), 'intent.md')),
            hasFyi: existsSync(join(REEF_KNOWLEDGE, name.toLowerCase(), 'fyi.md')),
          };
        });
        return ok({ count: groups.length, groups });
      }

      case 'reef_create_group': {
        const n = a.name;
        if (typeof n !== 'string' || !n.trim()) return errResponse('name is required');
        const cfg = loadConfig();
        if (cfg.groups[n]) return errResponse(`Group "${n}" already exists`);
        addGroupData(cfg, n, typeof a.company === 'string' ? a.company : undefined);
        saveConfig(cfg);
        return ok({ created: n, company: a.company ?? null });
      }

      case 'reef_assign_group': {
        const p = a.project;
        const g = a.group;
        if (typeof p !== 'string' || !p.trim()) return errResponse('project is required');
        if (typeof g !== 'string' || !g.trim()) return errResponse('group is required');
        const cfg = loadConfig();
        if (!cfg.groups[g]) return errResponse(`Group "${g}" does not exist. Create it first with reef_create_group.`);
        linkProject(cfg, p, g);
        saveConfig(cfg);
        return ok({ project: p, group: g, status: 'linked' });
      }

      case 'reef_unassign': {
        const p = a.project;
        if (typeof p !== 'string' || !p.trim()) return errResponse('project is required');
        const cfg = loadConfig();
        unlinkProject(cfg, p);
        saveConfig(cfg);
        return ok({ project: p, status: 'unassigned' });
      }

      case 'reef_resume': {
        const p = a.project;
        if (typeof p !== 'string' || !p.trim()) return errResponse('project is required');
        const db = getDb();
        const row = db
          .prepare(
            `SELECT session_id, ended_at, turn_count, tool_call_count,
                    total_input_tokens, total_output_tokens, primary_model
             FROM sessions
             WHERE project = ?
             ORDER BY ended_at DESC
             LIMIT 1`,
          )
          .get(p) as
          | {
              session_id: string;
              ended_at: string | null;
              turn_count: number;
              tool_call_count: number;
              total_input_tokens: number;
              total_output_tokens: number;
              primary_model: string | null;
            }
          | undefined;

        if (!row) {
          closeDb();
          return ok({ project: p, lastSession: null, note: 'no sessions recorded yet' });
        }

        const topTools = db
          .prepare(
            `SELECT tool_name, COUNT(*) c FROM tool_calls
             WHERE session_id = ?
             GROUP BY tool_name ORDER BY c DESC LIMIT 5`,
          )
          .all(row.session_id) as Array<{ tool_name: string; c: number }>;

        closeDb();

        const cfg = loadConfig();
        return ok({
          project: p,
          group: getGroupForProject(cfg, p),
          lastSession: {
            endedAt: row.ended_at,
            turns: row.turn_count,
            toolCalls: row.tool_call_count,
            tokens: {
              input: row.total_input_tokens,
              output: row.total_output_tokens,
            },
            primaryModel: row.primary_model,
            topTools: topTools.map((t) => ({ tool: t.tool_name, count: t.c })),
          },
        });
      }

      case 'reef_autogroup': {
        const result = runAutoGroup({ dryRun: a.dryRun === true });
        return ok({
          ...result,
          summary: result.dryRun
            ? `[dry run] Would create ${result.created.length} group(s) from ${result.totalProjects - result.alreadyGrouped.length} unassigned folders.`
            : `Created ${result.created.length} group(s). ${result.skippedSingletons.length} folder(s) stayed ungrouped (no obvious cluster).`,
        });
      }

      case 'reef_rename_group': {
        const o = a.oldName;
        const n = a.newName;
        if (typeof o !== 'string' || !o.trim()) return errResponse('oldName is required');
        if (typeof n !== 'string' || !n.trim()) return errResponse('newName is required');
        const cfg = loadConfig();
        renameGroup(cfg, o, n);
        saveConfig(cfg);
        return ok({ renamed: { from: o, to: n } });
      }

      case 'reef_merge_groups': {
        const s = a.source;
        const t = a.target;
        if (typeof s !== 'string' || !s.trim()) return errResponse('source is required');
        if (typeof t !== 'string' || !t.trim()) return errResponse('target is required');
        const cfg = loadConfig();
        mergeGroups(cfg, s, t);
        saveConfig(cfg);
        return ok({ merged: { from: s, into: t } });
      }

      case 'reef_set_company': {
        const g = a.group;
        const c = a.company;
        if (typeof g !== 'string' || !g.trim()) return errResponse('group is required');
        if (typeof c !== 'string') return errResponse('company must be a string (pass "" to clear)');
        const cfg = loadConfig();
        setGroupCompany(cfg, g, c);
        saveConfig(cfg);
        return ok({ group: g, company: c || null });
      }

      case 'reef_update_group_display_name': {
        const g = a.group;
        const d = a.displayName;
        if (typeof g !== 'string' || !g.trim()) return errResponse('group is required');
        if (typeof d !== 'string') return errResponse('displayName must be a string');
        const cfg = loadConfig();
        setGroupDisplayName(cfg, g, d);
        saveConfig(cfg);
        return ok({ group: g, displayName: d || null });
      }

      case 'reef_scan': {
        const summary = await scan({ force: a.force === true });
        closeDb();
        return ok(summary);
      }

      case 'reef_get_context': {
        const g = a.group;
        if (typeof g !== 'string' || !g.trim()) return errResponse('group is required');
        const cfg = loadConfig();
        const groupDef = cfg.groups[g];
        if (!groupDef) return errResponse(`Group "${g}" not found`);
        if (getGroupTrust(cfg, g) === 'deny') {
          return errResponse(`Trust tier for "${g}" is "deny" — context retrieval is blocked. Run \`reef trust ${g} read-only\` to allow.`);
        }
        const parts: string[] = [];
        // Company context
        const ctx = buildProjectContext(g, groupDef.displayName ?? g, groupDef.company ?? null);
        if (ctx.companyContext) parts.push(`## Company: ${ctx.company}\n\n${ctx.companyContext}`);
        // Scanned repo docs
        const docs = scanGroupRepoDocs(groupDef.projects, groupDef.docPaths);
        if (docs.length > 0) {
          const docList = docs.map((d) => `### ${d.title} (${d.relPath})\n\n${d.preview}`).join('\n\n---\n\n');
          parts.push(`## Project Documents\n\n${docList}`);
        }
        // decisions.md
        const decisions = readDecisions(g);
        if (decisions.length > 0) {
          const recent = decisions.slice(-10).reverse();
          const decList = recent.map((d) => `**${d.date}**: ${d.body}`).join('\n\n');
          parts.push(`## Decisions Log\n\n${decList}`);
        }
        if (parts.length === 0) {
          return ok({ group: g, note: 'No docs or decisions found yet. Drop PRD/TDD/spec .md files in the project repo and they will appear automatically.' });
        }
        return { content: [{ type: 'text', text: parts.join('\n\n---\n\n') }] };
      }

      case 'reef_log_decision': {
        const g = a.group;
        if (typeof g !== 'string' || !g.trim()) return errResponse('group is required');
        const cfg = loadConfig();
        if (!cfg.groups[g]) return errResponse(`Group "${g}" not found`);
        if (getGroupTrust(cfg, g) === 'deny') return errResponse(`Trust tier for "${g}" is "deny" — writes blocked.`);
        const title = typeof a.title === 'string' ? a.title : undefined;
        const why = typeof a.why === 'string' ? a.why : undefined;
        const impact = typeof a.impact === 'string' ? a.impact : undefined;
        const project = typeof a.project === 'string' ? a.project : undefined;
        const refs = Array.isArray(a.refs) ? a.refs.filter((r): r is string => typeof r === 'string') : undefined;
        const legacy = typeof a.decision === 'string' ? a.decision : undefined;
        const hasStructured = !!(title || why || impact || (refs && refs.length));
        if (!hasStructured && !legacy?.trim()) {
          return errResponse('Provide at least one of: title, why, impact, refs, decision');
        }
        appendDecision(g, hasStructured ? { title, why, impact, refs, project } : { body: legacy });
        return ok({ group: g, logged: true });
      }

      case 'reef_report_observation': {
        const title = a.title;
        const description = a.description;
        if (typeof title !== 'string' || !title.trim()) return errResponse('title is required');
        if (typeof description !== 'string' || !description.trim()) return errResponse('description is required');
        if (!autoReportEnabled()) {
          return ok({
            reported: false,
            reason: 'auto-report disabled',
            hint: 'Set REEF_AUTO_REPORT=1 and GITHUB_TOKEN in .env to enable.',
          });
        }
        const severity = typeof a.severity === 'string' ? a.severity : undefined;
        const fileRefs = Array.isArray(a.fileRefs) ? a.fileRefs.filter((r): r is string => typeof r === 'string') : undefined;
        const suggestedFix = typeof a.suggestedFix === 'string' ? a.suggestedFix : undefined;
        const result = await reportObservation({
          title,
          description,
          severity: severity as 'bug' | 'enhancement' | 'docs' | 'security' | 'performance' | undefined,
          fileRefs,
          suggestedFix,
        });
        return ok(result);
      }

      default:
        return errResponse(`Unknown tool: ${name}`);
    }
  } catch (e) {
    log.error('mcp tool threw', { tool: name, err: formatError(e) });
    autoReport({
      source: `mcp:${name}`,
      message: (e as Error).message ?? String(e),
      stack: (e as Error).stack,
    }).catch(() => { /* never let auto-report break us */ });
    return errResponse(formatError(e));
  }
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'reef', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleCall(name, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp server started (stdio)');
}
