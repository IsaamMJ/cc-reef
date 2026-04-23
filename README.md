<div align="center">

# 🪸 cc-reef

### *Know how well you're using Claude Code — without lifting a finger.*

A local-first effectiveness analyzer and context-recovery layer for [Claude Code](https://claude.com/claude-code).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43853d.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/runtime%20deps-2-brightgreen.svg)](package.json)
[![Local First](https://img.shields.io/badge/100%25-local-ff69b4.svg)](#-privacy--safety)

</div>

---

> [!NOTE]
> **reef** watches how you use Claude Code, helps you recover context between sessions, and quietly nudges you toward faster patterns — all from your own machine, with zero telemetry.

## ✨ Why reef exists

You're running Claude Code across **a dozen projects**. You lose 5 minutes at the start of each session just remembering where you left off. You've installed 47 plugins but you have no idea which are pulling their weight. You reach for `Bash("grep ...")` 200 times a week when `Grep` would be faster.

Nobody is measuring this. **reef is.**

<table>
<tr>
<td align="center" width="33%">

### 🧠 Remember
Resume card auto-injected at session start

</td>
<td align="center" width="33%">

### ⚡ Nudge
Live hints when you reach for slow patterns

</td>
<td align="center" width="33%">

### 📊 Report
Weekly markdown of your real habits

</td>
</tr>
</table>

---

## 🚀 Quickstart

```bash
git clone https://github.com/IsaamMJ/cc-reef.git
cd cc-reef
npm install && npm run build
node dist/cli.js install-hooks
```

That's it. Open your next Claude Code session and reef is already working.

> [!TIP]
> Requires **Node.js 22+** — reef uses the built-in `node:sqlite` so you never deal with native build tools.

---

## 🎬 See it in action

### 🔖 Resume card — injected automatically

When you open Claude Code in any tracked project:

```
[reef] Resume card — RiseCraft (Mind Smart Academy)
Last session 1h ago (5912 turns, 2438 tool calls, 3.16M tokens, model: claude-opus-4-6)
Top tools last time: Bash×932, Edit×526, Read×361, Write×193, Grep×138
```

No command. No checklist. You open CC → you know where you are.

---

### ⚠️ Live nudge — the moment you go off-pattern

You type: `Bash("grep -r TODO .")` → reef replies:

```
[reef] Use the Grep tool instead of rg/grep — faster and returns structured matches.
```

Your habits change in the moment, not in a report you never read.

---

### 🗂️ Group your 18 folders into 4 real projects

```bash
reef groups
```

```
? What would you like to do?
❯ View current groupings
  Assign unassigned projects
  Create new group
  Link project to group
  Delete group
  Exit
```

Interactive wizard — no JSON editing ever. Reports and resume cards then show:

```
RiseCraft (Mind Smart Academy)   instead of   E--RiseCraft-backend
                                               E--riseCraftfrontend
```

---

### 📈 Weekly report

```bash
reef report --days 7
```

<details>
<summary><b>Sample output (click to expand)</b></summary>

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

### PaperCraft
- Sessions: 19 · Turns: 6,476 · Tool calls: 3,241 · Tokens: 4.0M

## Top tools (all projects)
| Tool | Count | Share |
|------|------:|------:|
| Bash | 2,052 | 30.8% |
| Read | 1,498 | 22.5% |
| Edit | 1,419 | 21.3% |
| Grep |   758 | 11.4% |
| Write|   401 |  6.0% |

## Bash vs native tools
- Bash: **2,052**
- Grep + Glob + Read: **2,310**
- Bash / native ratio: **0.89**  ~ ok

## Quick wins
- Opus is dominant (22 vs 9 Haiku sessions). Consider Haiku for short, tool-light tasks.
- 7 project folder(s) are ungrouped — run `reef groups` to label them.
```

</details>

---

### 🩺 Health check

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
    tool calls          : 13 084
    last scan           : 2026-04-23T10:12:42Z
  config                : ~/.cc-reef/config.json
    groups              : 3
    unassigned folders  : 0
```

---

## 📜 Commands

| Command | Purpose |
|---|---|
| `reef init` | Show configured paths |
| `reef scan [--force]` | Parse transcripts into the local SQLite DB |
| `reef groups` | Interactive wizard — manage companies & products |
| `reef status` | Full health check: hooks, DB, config |
| `reef report [--days N]` | Generate a markdown activity report |
| `reef install-hooks [--dry-run]` | Register reef hooks in `~/.claude/settings.json` |
| `reef uninstall-hooks` | Remove reef's hooks (backs up first) |

---

## 🏗️ How it works

```
 ~/.claude/projects/<project>/*.jsonl  ← Claude Code writes transcripts
              │
              ▼
       reef scan  (recursive JSONL parser, 3s for 400 files)
              │
              ▼
  ~/.cc-reef/data.db   local SQLite — zero network
              │
  ┌───────────┼────────────────────┐
  ▼           ▼                    ▼
 status    report         hooks (resume card · nudge · post-scan)
```

| File                          | Purpose                                |
|-------------------------------|----------------------------------------|
| `~/.claude/projects/**.jsonl` | CC transcripts — **read-only** by reef |
| `~/.cc-reef/data.db`          | Aggregated session & tool-call stats   |
| `~/.cc-reef/config.json`      | Your company/product groupings         |
| `~/.cc-reef/logs/reef.log`    | Internal log (10 MB rotation)          |

---

## 🔒 Privacy & safety

> [!IMPORTANT]
> **Nothing ever leaves your machine.** No server, no account, no telemetry, no analytics.

- `install-hooks` **auto-backs up** `~/.claude/settings.json` before writing.
- Reef hooks **never block or crash** CC — any internal error is logged and swallowed.
- Malformed transcript lines are skipped with a warning; one bad line can't kill a scan.
- Atomic config writes (tmp + rename) — no corrupted config mid-write.
- Uninstall is one command:
  ```bash
  node dist/cli.js uninstall-hooks
  rm -rf ~/.cc-reef
  ```

---

## 🧪 Tested against real data

`v0.0.1` has been run against:

| Metric                  | Count        |
|-------------------------|--------------|
| Projects                | 18           |
| JSONL transcripts       | 401          |
| Tool-call events parsed | 13 041       |
| Total transcript size   | 284 MB       |
| Full-scan duration      | **~3 seconds** |
| Parse errors            | 0            |

---

## 🧭 Roadmap

- [x] Recursive JSONL scan with incremental mtime skip
- [x] SQLite schema + upsert pipeline
- [x] SessionStart / PreToolUse:Bash / Stop hooks
- [x] Interactive groups wizard (no JSON editing)
- [x] Markdown reports with per-group breakdown
- [x] Health check
- [ ] `reef report-bug` — prefilled GitHub issue from sanitised logs
- [ ] Tighten nudge regex (reduce `tail -n`/heredoc false positives)
- [ ] Ink-based TUI dashboard
- [ ] Publish to npm
- [ ] Cross-machine config sync (optional, opt-in)

---

## 🤝 Contributing

Issues and PRs welcome. This is early software — the **best contribution right now is using it for a week and filing issues about what surprised you**.

```bash
git clone https://github.com/IsaamMJ/cc-reef.git
cd cc-reef
npm install
npm run build
npm run typecheck
```

---

## 🧑‍💻 Requirements

- **Node.js 22+** (for `node:sqlite`)
- Claude Code installed
- Works on **Windows**, **macOS**, and **Linux**

---

<div align="center">

### 📝 License

**MIT** — see [LICENSE](LICENSE).

*Built for developers who live in Claude Code and want their tools to work as hard as they do.*

</div>
