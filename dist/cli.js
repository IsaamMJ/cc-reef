#!/usr/bin/env node
import { loadDotEnv } from './dotenv.js';
loadDotEnv();
import { Command } from 'commander';
import { log } from './log.js';
import { formatError } from './formatError.js';
import { isAbortError } from './errors.js';
import { CLAUDE_PROJECTS, REEF_HOME, REEF_CONFIG } from './paths.js';
import { scan } from './scan.js';
import { closeDb } from './db.js';
import { listProjectFolders } from './projects.js';
import { promptForAllUnassigned, runGroupsWizard } from './wizard.js';
import { installHooks, uninstallHooks } from './installHooks.js';
import { runHook } from './hooks/runner.js';
import { getStatus, printStatus } from './status.js';
import { writeReport } from './report.js';
import { generateRetro } from './retro.js';
import { startServer } from './server.js';
import { summarizeRecent } from './summarize.js';
import { nimAvailable } from './nim.js';
import { listAllOverviews, getOverview, listFyiEntries, searchKnowledge, pruneFyiBefore, pruneFyiByIndex, exportKnowledge, } from './knowledge.js';
import { reportBug, previewBugReport } from './reportBug.js';
import { runMcpServer } from './mcp.js';
import { runAutoGroup } from './autoGroup.js';
import { runInit } from './init.js';
import { runStatusline, installStatusline, uninstallStatusline, } from './statusline.js';
import { readCompanyContext, readProjectIntent, readFyiRecent, listAdrs, } from './context.js';
import { loadConfig, saveConfig, setGroupTrust, getGroupTrust } from './groups.js';
const program = new Command();
program
    .name('reef')
    .description('Claude Code effectiveness analyzer and context recovery')
    .version('0.0.1');
program
    .command('init')
    .description('One-command setup: install hooks + register MCP + scan + autogroup')
    .option('--skip-hooks', 'do not install Claude Code hooks')
    .option('--skip-mcp', 'do not register the MCP server')
    .option('--skip-scan', 'do not run the first scan')
    .option('--skip-autogroup', 'do not auto-group folders')
    .action(async (opts) => {
    log.info('init invoked', { opts });
    await runInit({
        skipHooks: opts.skipHooks,
        skipMcp: opts.skipMcp,
        skipScan: opts.skipScan,
        skipAutogroup: opts.skipAutogroup,
    });
});
program
    .command('paths')
    .description('Show configured paths')
    .action(() => {
    console.log('reef paths');
    console.log(`  Claude projects     : ${CLAUDE_PROJECTS}`);
    console.log(`  Reef data dir       : ${REEF_HOME}`);
    console.log(`  Reef config         : ${REEF_CONFIG}`);
});
program
    .command('scan')
    .description('Parse Claude Code transcripts into the local database')
    .option('-f, --force', 'rescan files even if unchanged since last scan')
    .option('--no-prompt', 'skip interactive prompts for unassigned projects')
    .action(async (opts) => {
    log.info('scan invoked', { force: !!opts.force, prompt: opts.prompt !== false });
    const interactive = opts.prompt !== false && !!process.stdin.isTTY;
    if (interactive) {
        const r = await promptForAllUnassigned(listProjectFolders());
        if (r.assigned + r.skipped > 0) {
            console.log(`Assignment: ${r.assigned} new, ${r.skipped} skipped.\n`);
        }
    }
    const summary = await scan({ force: opts.force });
    console.log('reef scan complete');
    console.log(`  projects            : ${summary.projects}`);
    console.log(`  files scanned       : ${summary.filesScanned}`);
    console.log(`  files skipped       : ${summary.filesSkipped}`);
    console.log(`  sessions upserted   : ${summary.sessionsUpserted}`);
    console.log(`  tool calls stored   : ${summary.toolCallsInserted}`);
    console.log(`  parse errors        : ${summary.parseErrors}`);
    console.log(`  duration            : ${summary.durationMs} ms`);
    closeDb();
});
program
    .command('groups')
    .description('Interactive wizard to manage project groups (companies/products)')
    .action(async () => {
    log.info('groups wizard invoked');
    const projects = listProjectFolders();
    if (projects.length === 0) {
        console.log(`No project folders found under ${CLAUDE_PROJECTS}.`);
        return;
    }
    await runGroupsWizard(projects);
});
program
    .command('install-hooks')
    .description('Register reef hooks (SessionStart, PreToolUse:Bash, Stop) into ~/.claude/settings.json')
    .option('--cli-path <path>', 'explicit path to the compiled cli.js (dev override)')
    .option('--dry-run', 'show what would change without writing')
    .action((opts) => {
    const result = installHooks({
        cliPath: opts.cliPath,
        dryRun: opts.dryRun,
    });
    console.log(opts.dryRun ? 'reef install-hooks (dry run)' : 'reef install-hooks');
    console.log(`  settings     : ${result.settingsPath}`);
    if (result.backupPath)
        console.log(`  backup       : ${result.backupPath}`);
    console.log(`  added        : ${result.added}`);
    console.log(`  updated      : ${result.updated}`);
    for (const c of result.commands) {
        console.log(`  - ${c.event}: ${c.command}`);
    }
    if (!opts.dryRun) {
        console.log('\nHooks are live on your next Claude Code session.');
    }
});
program
    .command('uninstall-hooks')
    .description('Remove reef hooks from ~/.claude/settings.json')
    .action(() => {
    const result = uninstallHooks();
    console.log('reef uninstall-hooks');
    if (result.backupPath)
        console.log(`  backup       : ${result.backupPath}`);
    console.log(`  removed      : ${result.removed}`);
});
program
    .command('report-bug')
    .description('Open a prefilled GitHub issue with a sanitised recent log')
    .option('--no-open', "don't open the browser, just print the URL")
    .option('--print', 'print the sanitised log to stdout and exit')
    .option('-t, --title <title>', 'issue title (default "[bug] ")')
    .action((opts) => {
    if (opts.print) {
        console.log(previewBugReport());
        return;
    }
    const result = reportBug({
        noOpen: opts.open === false,
        title: opts.title,
    });
    console.log('reef report-bug');
    console.log(`  log lines included : ${result.logLinesIncluded}`);
    console.log(`  body length        : ${result.bodyLength} chars`);
    if (opts.open === false) {
        console.log('\nURL:');
        console.log(result.url);
    }
    else {
        console.log('\nOpening issue in your browser. Review and submit when ready.');
    }
});
program
    .command('status')
    .description('Show reef health: hooks installed, DB stats, last scan, groups')
    .action(() => {
    printStatus(getStatus());
});
program
    .command('report')
    .description('Generate a markdown activity report from the scanned data')
    .option('-d, --days <n>', 'look back N days (default 7)', (v) => parseInt(v, 10), 7)
    .option('--since <iso>', 'look back since ISO timestamp (overrides --days)')
    .option('-o, --out <file>', 'write report to file instead of stdout')
    .action((opts) => {
    const { content, outFile } = writeReport({
        days: opts.days,
        since: opts.since,
        outFile: opts.out,
    });
    if (outFile) {
        console.log(`reef report written to ${outFile}`);
    }
    else {
        process.stdout.write(content);
    }
});
program
    .command('retro')
    .description('Coaching-style weekly retro on how you used Claude Code (wins, fixes, one prescription)')
    .option('-d, --days <n>', 'look back N days (default 7)', (v) => parseInt(v, 10), 7)
    .option('--since <iso>', 'look back since ISO timestamp (overrides --days)')
    .action((opts) => {
    const content = generateRetro({ days: opts.days, since: opts.since });
    process.stdout.write(content);
});
const statuslineCmd = program
    .command('statusline')
    .description('Claude Code status line integration (install / uninstall / run)');
statuslineCmd
    .command('install')
    .description('Wrap your current status line so reef appends a company/group segment')
    .option('--cli-path <path>', 'explicit path to compiled cli.js (dev override)')
    .action((opts) => {
    const r = installStatusline({ cliPath: opts.cliPath });
    console.log(`reef statusline ${r.action}`);
    console.log(`  settings       : ${r.settingsPath}`);
    if (r.backupPath)
        console.log(`  backup         : ${r.backupPath}`);
    if (r.previousCommand)
        console.log(`  now wrapping   : ${r.previousCommand}`);
    else
        console.log('  no prior status line — reef runs alone');
    console.log(`  new command    : ${r.newCommand}`);
    console.log('\nRestart Claude Code to see the new status line.');
});
statuslineCmd
    .command('uninstall')
    .description("Remove reef from the status line and restore your previous command")
    .action(() => {
    const r = uninstallStatusline();
    console.log('reef statusline uninstalled');
    if (r.backupPath)
        console.log(`  backup         : ${r.backupPath}`);
    console.log(`  restored       : ${r.restored ?? '(no previous command)'}`);
});
statuslineCmd
    .command('run', { hidden: true })
    .description('(internal) emit the current status line — invoked by Claude Code')
    .action(async () => {
    await runStatusline();
});
program
    .command('autogroup')
    .description('Auto-group unassigned project folders by name similarity')
    .option('--dry-run', 'show what would happen without writing config')
    .action((opts) => {
    const r = runAutoGroup({ dryRun: opts.dryRun });
    console.log(`reef autogroup${r.dryRun ? ' (dry run)' : ''}`);
    console.log(`  total projects      : ${r.totalProjects}`);
    console.log(`  already grouped     : ${r.alreadyGrouped.length}`);
    console.log(`  new groups created  : ${r.created.length}`);
    for (const g of r.created) {
        console.log(`    - ${g.group}: ${g.projects.join(', ')}`);
    }
    console.log(`  ungrouped singletons: ${r.skippedSingletons.length}`);
    for (const s of r.skippedSingletons) {
        console.log(`    - ${s}`);
    }
});
const contextCmd = program
    .command('context')
    .description('View company and project context (company info, intent, decision log, ADRs)');
contextCmd
    .command('show <group>')
    .description('Show all context for a group')
    .action((group) => {
    const cfg = loadConfig();
    const def = cfg.groups[group];
    if (!def) {
        console.error(`Group "${group}" not found. Run: reef groups`);
        process.exit(1);
    }
    const company = def.company ?? null;
    const displayName = def.displayName ?? group;
    console.log(`\nreef context — ${displayName}${company ? ` (${company})` : ''}`);
    console.log('─'.repeat(50));
    if (company) {
        const cc = readCompanyContext(company);
        console.log(`\n## Company: ${company}`);
        console.log(cc ?? '  (none — ask Claude: "reef, set context for Jiive: ...")');
    }
    const intent = readProjectIntent(group);
    console.log(`\n## Project Intent`);
    console.log(intent ?? '  (none — ask Claude: "reef, set intent for this project: ...")');
    const fyi = readFyiRecent(group, 10);
    console.log(`\n## Recent Decisions (last 10)`);
    console.log(fyi ?? '  (none — ask Claude to call reef_update_fyi after decisions)');
    const adrs = listAdrs(group);
    if (adrs.length > 0) {
        console.log(`\n## ADRs (${adrs.length})`);
        adrs.forEach((f) => console.log(`  - ${f}`));
    }
    console.log('');
});
const knowledgeCmd = program
    .command('knowledge')
    .description('Manage what reef has learned (intent, fyi decisions, ADRs)');
knowledgeCmd
    .command('list [group]')
    .description('Show knowledge overview for one group, or all groups if omitted')
    .action((group) => {
    if (group) {
        const o = getOverview(group);
        console.log(`reef knowledge — ${o.groupKey}`);
        console.log(`  intent       : ${o.hasIntent ? `${o.intentBytes} bytes` : '(none)'}`);
        console.log(`  fyi entries  : ${o.fyiCount} (${o.fyiBytes} bytes)`);
        console.log(`  ADRs         : ${o.adrCount}`);
        const entries = listFyiEntries(group);
        if (entries.length > 0) {
            console.log(`\n  recent fyi:`);
            for (const e of entries.slice(-5)) {
                const preview = e.body.split('\n')[0]?.slice(0, 80) ?? '';
                console.log(`    [${e.index}] ${e.date} — ${preview}`);
            }
        }
        return;
    }
    const all = listAllOverviews();
    console.log('reef knowledge');
    console.log('  group                 intent  fyi  adrs');
    for (const o of all) {
        const intent = o.hasIntent ? '  ✓  ' : '  -  ';
        console.log(`  ${o.groupKey.padEnd(20)} ${intent} ${String(o.fyiCount).padStart(4)} ${String(o.adrCount).padStart(5)}`);
    }
});
knowledgeCmd
    .command('search <group> <query>')
    .description('Search fyi entries and ADRs for a query string')
    .action((group, query) => {
    const r = searchKnowledge(group, query);
    console.log(`reef knowledge search — "${query}" in ${group}`);
    console.log(`  fyi matches : ${r.fyi.length}`);
    for (const e of r.fyi) {
        const preview = e.body.slice(0, 200).replace(/\n/g, ' ');
        console.log(`    [${e.index}] ${e.date} — ${preview}`);
    }
    console.log(`  adr matches : ${r.adrs.length}`);
    for (const a of r.adrs) {
        console.log(`    ${a.file} — ...${a.snippet}...`);
    }
});
knowledgeCmd
    .command('prune <group>')
    .description('Remove fyi entries (by index or before a date)')
    .option('--before <date>', 'remove entries dated before YYYY-MM-DD')
    .option('--index <indices>', 'comma-separated indices to remove (e.g. 0,1,4)')
    .action((group, opts) => {
    if (!opts.before && !opts.index) {
        console.error('Provide --before YYYY-MM-DD or --index 0,1,2');
        process.exit(1);
    }
    let removed = 0;
    if (opts.before)
        removed += pruneFyiBefore(group, opts.before);
    if (opts.index) {
        const idx = opts.index.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        removed += pruneFyiByIndex(group, idx);
    }
    console.log(`reef knowledge prune — removed ${removed} fyi entr${removed === 1 ? 'y' : 'ies'} from ${group}`);
});
knowledgeCmd
    .command('export <group>')
    .description('Print all knowledge for a group as one markdown bundle (for backup or sharing)')
    .option('-o, --out <file>', 'write to file instead of stdout')
    .action((group, opts) => {
    const md = exportKnowledge(group);
    if (opts.out) {
        const { writeFileSync } = require('node:fs');
        writeFileSync(opts.out, md, 'utf8');
        console.log(`reef knowledge exported to ${opts.out}`);
    }
    else {
        process.stdout.write(md);
    }
});
program
    .command('summarize')
    .description('Generate one-line AI summaries for recent sessions (requires NIM_API_KEY)')
    .option('-n, --limit <n>', 'how many recent sessions to summarize', (v) => parseInt(v, 10), 20)
    .option('--force', 'regenerate even if a summary already exists')
    .action(async (opts) => {
    if (!nimAvailable()) {
        console.error('NIM_API_KEY not set. Get a free key at https://build.nvidia.com and export NIM_API_KEY=...');
        process.exit(1);
    }
    console.log(`reef summarize — up to ${opts.limit ?? 20} sessions (force=${!!opts.force})`);
    const r = await summarizeRecent(opts.limit ?? 20, !!opts.force);
    console.log(`  summarized : ${r.done}`);
    console.log(`  skipped    : ${r.skipped}`);
    console.log(`  failed     : ${r.failed}`);
    closeDb();
});
program
    .command('serve')
    .description('Run the reef web dashboard at localhost:7777')
    .option('-p, --port <port>', 'port to listen on (default 7777)', (v) => parseInt(v, 10), 7777)
    .action((opts) => {
    startServer(opts.port);
});
program
    .command('trust <group> [tier]')
    .description('Show or set trust tier for a group: read-write | read-only | deny')
    .action((group, tier) => {
    let cfg = loadConfig();
    if (!cfg.groups[group]) {
        console.error(`Group "${group}" not found`);
        process.exit(1);
    }
    if (!tier) {
        console.log(`reef trust — ${group}: ${getGroupTrust(cfg, group)}`);
        return;
    }
    if (tier !== 'read-write' && tier !== 'read-only' && tier !== 'deny') {
        console.error(`Invalid tier "${tier}". Use: read-write | read-only | deny`);
        process.exit(1);
    }
    cfg = setGroupTrust(cfg, group, tier);
    saveConfig(cfg);
    console.log(`reef trust — ${group} set to ${tier}`);
    if (tier === 'read-only')
        console.log('  Claude can read context but cannot write fyi/intent/ADRs.');
    if (tier === 'deny')
        console.log('  Claude cannot read or write any context for this group.');
});
program
    .command('mcp')
    .description('Run reef as an MCP server (stdio). Register in your client config to expose reef tools to Claude.')
    .action(async () => {
    await runMcpServer();
});
// Hidden hook dispatcher — invoked by Claude Code, not end users.
program
    .command('hook <name>', { hidden: true })
    .description('(internal) hook dispatcher')
    .action(async (name) => {
    await runHook(name);
});
program.parseAsync(process.argv).catch((err) => {
    if (isAbortError(err)) {
        process.exit(130);
    }
    log.error('fatal', { error: formatError(err) });
    console.error(formatError(err));
    process.exit(1);
});
//# sourceMappingURL=cli.js.map