#!/usr/bin/env node
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
import { reportBug, previewBugReport } from './reportBug.js';
import { runMcpServer } from './mcp.js';
import { runAutoGroup } from './autoGroup.js';
import { runInit } from './init.js';
import { runStatusline, installStatusline, uninstallStatusline, } from './statusline.js';
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