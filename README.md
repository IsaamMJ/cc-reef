# cc-reef

A local-first effectiveness analyzer and context-recovery tool for [Claude Code](https://claude.com/claude-code).

Answers three questions without ever sending your data anywhere:

- **Am I using Claude Code efficiently?** — reports on tool usage, model mix, token burn, and habits across every project.
- **Where was I?** — injects an auto-generated resume card at the start of every session so you never have to re-orient.
- **Am I wasting tokens?** — live nudges when you shell out to `grep`/`find`/`cat`/`sed` instead of using CC's native `Grep`/`Glob`/`Read`/`Edit` tools.

Everything runs 100% locally. No server, no account, no telemetry. Your transcripts never leave your machine.

---

## Install

Requires Node.js 22+ (for built-in `node:sqlite` — zero native deps).

```bash
git clone https://github.com/IsaamMJ/cc-reef.git
cd cc-reef
npm install
npm run build
node dist/cli.js install-hooks
```

That wires reef into `~/.claude/settings.json` and backs up your existing settings first. The next CC session you open will be tracked.

---

## Key features

### 1. Automatic resume card

When you open Claude Code in any tracked project, reef injects a card showing where you left off:

```
[reef] Resume card — RiseCraft (Mind Smart Academy)
Last session 1h ago (5912 turns, 2438 tool calls, 3.16M tokens, model: claude-opus-4-6)
Top tools last time: Bash×932, Edit×526, Read×361, Write×193, Grep×138
```

Zero commands, zero manual bookkeeping.

### 2. Live behavior nudges

If you ask Claude to `Bash("grep -r foo .")`, reef intercepts and injects:

```
[reef] Use the Grep tool instead of rg/grep — faster and returns structured matches.
```

Behavior changes in the moment, not in a report you never read.

### 3. Group folders by company / product

Your 18 Claude project folders probably span 4-5 real products. Reef lets you group them with an interactive wizard (no JSON editing):

```bash
reef groups
```

```
? What would you like to do?
  > Assign unassigned projects
    Create new group
    Link project to group
    View current groupings
```

Resume cards and reports then show `RiseCraft (Mind Smart Academy)` instead of `E--RiseCraft-backend` + `E--riseCraftfrontend` as separate noise.

### 4. Weekly report

```bash
reef report --days 7
```

```markdown
# reef report
**Window:** since 2026-04-16

## Overview
- Sessions: **40**
- Turns: **14,850**
- Tool calls: **6,671**
- Tokens in / out: **80.7k** / **6.13M**

## By group
### RiseCraft (Mind Smart Academy)
- Sessions: 14 · Turns: 3,100 · Tool calls: 1,820 · Tokens: 3.4M
- Top tools: Read×412, Edit×203, Bash×118

## Top tools (all projects)
| Tool | Count | Share |
|------|------:|------:|
| Bash | 2,052 | 30.8% |
| Read | 1,498 | 22.5% |
| Edit | 1,419 | 21.3% |
...

## Bash vs native tools
- Bash / native ratio: **0.89** ~ ok

## Quick wins
- Opus is dominant (22 vs 9 Haiku sessions). Consider Haiku for short, tool-light tasks.
- 7 project folder(s) are ungrouped — run `reef groups` to label them.
```

### 5. Health check

```bash
reef status
```

```
reef status
  overall active        : YES
  settings file         : ~/.claude/settings.json
    SessionStart hook   : yes
    PreToolUse:Bash hook: yes
    Stop hook           : yes
  database              : 2.7 MB
    sessions tracked    : 401
    tool calls          : 13084
    last scan           : 2026-04-23T10:12:42Z
  config                : ~/.cc-reef/config.json
    groups              : 3
    unassigned folders  : 0
```

### 6. Post-session auto-scan

The `Stop` hook incrementally parses new transcripts after every CC session ends. Your DB stays fresh without ever running a command.

---

## Commands

| Command | Purpose |
|---|---|
| `reef init` | Show configured paths |
| `reef scan [--force] [--no-prompt]` | Parse transcripts into the local SQLite DB |
| `reef groups` | Interactive wizard: manage companies/products |
| `reef status` | Health check: hooks, DB, config |
| `reef report [--days N] [--out file]` | Generate a markdown activity report |
| `reef install-hooks [--dry-run]` | Register reef hooks in `~/.claude/settings.json` |
| `reef uninstall-hooks` | Remove reef's hooks (backup + clean remove) |

---

## How it works

```
~/.claude/projects/<project>/*.jsonl   ← Claude Code writes transcripts here
            │
            ▼
     reef scan (recursive JSONL parser)
            │
            ▼
~/.cc-reef/data.db  (local SQLite, no network)
            │
            ▼
   ┌────────┼─────────────┐
   ▼        ▼             ▼
status   report    hooks (resume card + nudges)
```

All data is local:

- `~/.claude/projects/` — where Claude Code already logs every session (reef reads only).
- `~/.cc-reef/data.db` — local SQLite aggregate.
- `~/.cc-reef/config.json` — your company/product groupings.
- `~/.cc-reef/logs/reef.log` — internal log, 10 MB rotation.

Uninstalling returns the system to its original state:

```bash
node dist/cli.js uninstall-hooks
rm -rf ~/.cc-reef
```

---

## Safety

- `install-hooks` **backs up** `~/.claude/settings.json` to `.reef-backup-<timestamp>` before writing.
- Hooks **never block or fail** CC — any internal error is swallowed and logged; the user sees nothing.
- Malformed transcript lines are skipped with a warning; one bad line doesn't kill a scan.
- Atomic config writes (tmp + rename) can't corrupt config mid-write.

---

## Requirements

- Node.js **22+** (for `node:sqlite`)
- Claude Code installed
- Works on Windows, macOS, Linux

---

## Status

v0.0.1 — early. Things that work today:

- Recursive JSONL scan (tested on 401 sessions / 13k tool calls / 3 seconds)
- Incremental re-scan (mtime-based skip)
- Resume card, bash nudge, post-session scan hooks
- Interactive groups wizard with inline prompts
- Markdown reports with per-group breakdown
- Health check

Planned:

- `reef report-bug` — prefilled GitHub issue from sanitised logs
- Nudge rule refinement (currently catches `tail -n` false positives)
- Ink-based TUI dashboard (`reef` with no args)

---

## License

MIT
