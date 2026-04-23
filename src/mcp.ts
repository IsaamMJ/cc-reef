import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { getStatus } from './status.js';
import { generateReport } from './report.js';
import { scan } from './scan.js';
import { closeDb, getDb } from './db.js';
import {
  loadConfig,
  saveConfig,
  addGroup as addGroupData,
  linkProject,
  unlinkProject,
  getGroupForProject,
  getUnassignedProjects,
  listGroupNames,
  UNGROUPED,
} from './groups.js';
import { listProjectFolders } from './projects.js';
import { log } from './log.js';
import { formatError } from './formatError.js';

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

      case 'reef_list_projects': {
        const cfg = loadConfig();
        const projects = listProjectFolders().map((project) => ({
          project,
          group: getGroupForProject(cfg, project) ?? UNGROUPED,
        }));
        return ok({ count: projects.length, projects });
      }

      case 'reef_list_groups': {
        const cfg = loadConfig();
        const groups = listGroupNames(cfg).map((name) => ({
          name,
          company: cfg.groups[name]?.company ?? null,
          projects: cfg.groups[name]?.projects ?? [],
        }));
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

      case 'reef_scan': {
        const summary = await scan({ force: a.force === true });
        closeDb();
        return ok(summary);
      }

      default:
        return errResponse(`Unknown tool: ${name}`);
    }
  } catch (e) {
    log.error('mcp tool threw', { tool: name, err: formatError(e) });
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
