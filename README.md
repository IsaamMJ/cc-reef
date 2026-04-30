<div align="center">

# 🪸 cc-reef

### *The doc layer that survives AI-assisted refactoring.*

[![Status: Archived](https://img.shields.io/badge/status-archived-red.svg)](POSTMORTEM.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43853d.svg)](https://nodejs.org)

</div>

---

> ## ⚠️ Project archived — failed
>
> **As of 2026-04-30, cc-reef is archived and no longer maintained.**
>
> The mental model (truth hierarchy, code-vs-doc verdicts, living-truth-first methodology) was sound. The implementation was not — it was built as a separate web app with xAI Grok as a second LLM, doing work that Claude Code with native filesystem + git access could do more reliably for free.
>
> **The replacement** is a Claude Code skill (one Markdown file at `.claude/skills/audit-doc.md`) that encodes the audit playbook. Trigger with `/audit <doc>` in your IDE — Claude reads CLAUDE.md, the doc, greps code, checks git, writes findings to `.cc-reef/audits/<doc>-<timestamp>.md`, and edits files natively when you ask.
>
> Read the full retrospective: **[POSTMORTEM.md](POSTMORTEM.md)** — what worked, what didn't, why it failed, and the lessons that survive.

---

A local-first decision-capture, drift-detection, and living-docs layer for [Claude Code](https://claude.com/claude-code) and any agent framework on top of it.

---

## 💡 The real problem

You start a project with a clean PRD and TDD. Then you spend two weeks pair-programming with Claude. By Friday: the code has moved, the docs haven't. Architectural pivots happened in conversation and were never written down. Three months later, *no one remembers what was decided about auth*.

Reef solves that. Every session it watches:

- **Captures decisions** automatically (`reef_log_decision` MCP tool + LLM-suggested at session end).
- **Detects drift** in real time (PostToolUse hook re-checks claims after every edit).
- **Patches docs** when reality changes (LLM proposes diffs; you approve in a web UI).

It also still does the original group-by-product analytics, because once you've worked on 18 folders across 4 companies, you stop wanting flat lists.

### Multi-product organisation (still here)

You work across **multiple clients**. Each client has **multiple repos** — a backend, a website, maybe a mobile app. Claude Code sees 18 flat folders. *You* see 4 real products across 3 companies.

Every other tool asks you to look at this:

```
E--ClientA-backend        E--ClientB-api
E--ClientA-website        E--ClientB-mobile
E--ClientA-admin          E--Side-Project
```

**reef asks how your brain actually groups them:**

```
🏢 Acme Corp
  └─ Acme            backend · website · admin     (12 sessions, 2.1M tokens)

🏢 Northwind Labs
  └─ Northwind       api · mobile                   (14 sessions, 3.4M tokens)

📦 Helix            (standalone)                    (19 sessions, 4.0M tokens)
```

That's the feature no other Claude Code tool has. Everything else — resume cards, nudges, weekly reports — is built on top of this mental model.

---

## ✨ What reef does

<table>
<tr>
<td align="center" width="25%">

### 🗂️
### Group
Company → Product → Repos. One keystroke setup.

</td>
<td align="center" width="25%">

### 🧠
### Remember
Resume card auto-injected at session start.

</td>
<td align="center" width="25%">

### ⚡
### Nudge
Live hints when you reach for slow patterns.

</td>
<td align="center" width="25%">

### 📊
### Report
Weekly markdown of your real habits.

</td>
</tr>
</table>

---

## 🚀 Quickstart

### Recommended — install as a Claude Code plugin (no terminal)

Inside any Claude Code session:

```
/plugin marketplace add https://github.com/IsaamMJ/cc-reef
/plugin install cc-reef@cc-reef
```

That's it. Hooks, the MCP server, and all commands register automatically. No terminal, no absolute paths, no build step. Your next session starts with reef active.

### Alternative — clone + one command

If you prefer a local clone (or want to hack on it):

```bash
git clone https://github.com/IsaamMJ/cc-reef.git
cd cc-reef
npm install && npm run build
node dist/cli.js init
```

`reef init` is a single idempotent command that installs hooks, registers the MCP server with Claude Code, runs the first scan, and auto-groups your project folders. Safe to re-run anytime.

> [!WARNING]
> If you already installed via the clone method and now want the plugin: first run `node dist/cli.js uninstall-hooks` and `claude mcp remove reef` to avoid duplicate hook firing, then `/plugin install`.

> [!TIP]
> Requires **Node.js 22+** — reef uses the built-in `node:sqlite` so you never deal with native build tools.

---

## 🎬 See it in action

### 🗂️ Group once, forever grouped

`reef groups` opens an interactive wizard — **no JSON editing, ever**:

```
? Groups — what would you like to do?
❯ Assign unassigned projects
  Create new group
  Link project to group
  View current groupings
  Exit
```

New folder appears in `~/.claude/projects/`? The next `scan` prompts inline:

```
? New project folder: E--NewClient-frontend
❯ Acme Corp
  Northwind Labs
  Helix
  + Create new group
  Skip this one
  Skip all remaining
```

One keystroke → assigned → never asked again.

Your groupings live at `~/.cc-reef/config.json` — portable across machines, version-controllable if you want.

---

### 🧠 Resume card — injected automatically

Every CC session you open, reef tells you where you left off:

```
[reef] Resume card — Acme (Acme Corp)
Last session 1h ago (5,912 turns, 2,438 tool calls, 3.16M tokens, model: claude-opus-4-6)
Top tools last time: Bash×932, Edit×526, Read×361, Write×193, Grep×138
```

No command. No checklist. CC opens → you know where you are.

---

### ⚠️ Live nudge — the moment you go off-pattern

You ask Claude to `Bash("grep -r TODO .")` and reef replies instantly:

```
[reef] Use the Grep tool instead of rg/grep — faster and returns structured matches.
```

Your habits change *in the moment*, not in a report you never read.

---

### 📈 Weekly report — grouped by company

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
### Acme (Acme Corp)
- Sessions: 14 · Turns: 3,100 · Tool calls: 1,820 · Tokens: 3.4M
- Top tools: Read×412, Edit×203, Bash×118

### Northwind (Northwind Labs)
- Sessions: 7 · Turns: 1,280 · Tool calls: 740 · Tokens: 1.1M

### Helix
- Sessions: 19 · Turns: 6,476 · Tool calls: 3,241 · Tokens: 4.0M

## Top tools (all projects)
| Tool | Count | Share |
|------|------:|------:|
| Bash | 2,052 | 30.8% |
| Read | 1,498 | 22.5% |
| Edit | 1,419 | 21.3% |
| Grep |   758 | 11.4% |

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
    tool calls          : 13,084
    last scan           : 2026-04-23T10:12:42Z
  config                : ~/.cc-reef/config.json
    groups              : 3
    unassigned folders  : 0
```

---

## 🤖 Use reef inside Claude Code (MCP)

reef ships as an **MCP server** — once registered, Claude invokes reef tools directly, no terminal and no Bash-permission prompts.

### Register with Claude Code

```bash
claude mcp add reef -- node "<absolute-path>/cc-reef/dist/cli.js" mcp
```

### Or add to your client config manually

```json
{
  "mcpServers": {
    "reef": {
      "command": "node",
      "args": ["/absolute/path/to/cc-reef/dist/cli.js", "mcp"]
    }
  }
}
```

### What Claude can then do naturally

```
you:    "reef, how was my week across RiseCraft?"
claude: <calls reef_report> → summarises grouped output

you:    "reef, put E--RiseCraft-backend under a new group called RiseCraft"
claude: <calls reef_create_group> then <calls reef_assign_group>
        done — now grouped.

you:    "reef, where did I leave off in E--CCIsaam?"
claude: <calls reef_resume> → shows last session stats + top tools
```

### Tools exposed

| Tool                 | Purpose                                                  |
|----------------------|----------------------------------------------------------|
| `reef_status`        | Health check                                             |
| `reef_report`        | Markdown weekly report (grouped)                         |
| `reef_resume`        | "Where did I leave off" card for a project               |
| `reef_list_projects` | All CC folders with their group                          |
| `reef_list_groups`   | All groups with members & company                        |
| `reef_create_group`  | Create a new group                                       |
| `reef_assign_group`  | Link a folder to a group                                 |
| `reef_unassign`      | Remove a folder from its group                           |
| `reef_scan`          | Force a DB refresh (normally automatic via Stop hook)    |

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
| `reef mcp` | Run reef as an MCP server over stdio |
| `reef report-bug` | Open a prefilled, sanitised GitHub issue |

---

## 🏗️ How it works

```
 ~/.claude/projects/<folder>/*.jsonl   ← Claude Code writes transcripts
              │
              ▼
       reef scan   recursive JSONL parser — 3s for 400 files
              │
              ▼
  ~/.cc-reef/data.db   local SQLite — zero network
              │
              ▼
      Your groups   (config.json defines Company → Product → Repos)
              │
  ┌───────────┼─────────────────────┐
  ▼           ▼                     ▼
 status    report          hooks (resume · nudge · post-scan)
```

| File                          | Purpose                                 |
|-------------------------------|-----------------------------------------|
| `~/.claude/projects/**.jsonl` | CC transcripts — **read-only** by reef  |
| `~/.cc-reef/data.db`          | Aggregated session & tool-call stats    |
| `~/.cc-reef/config.json`      | Your **company / product** groupings    |
| `~/.cc-reef/logs/reef.log`    | Internal log (10 MB rotation)           |

---

## 🔒 Privacy & safety

> [!IMPORTANT]
> **Reef itself never phones home.** No server. No account. No telemetry. No analytics.
>
> **Optional caveat:** if you opt in to AI-powered summaries by setting `NIM_API_KEY`,
> reef sends transcript fragments to NVIDIA's NIM API to generate summaries. The default
> install never sets this — without that env var, reef is fully local.

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

`v0.0.1` has been stress-tested with:

| Metric                  | Count          |
|-------------------------|----------------|
| Projects                | 18             |
| JSONL transcripts       | 401            |
| Tool-call events parsed | 13,041         |
| Total transcript size   | 284 MB         |
| Full-scan duration      | **~3 seconds** |
| Parse errors            | 0              |

---

## 🧭 Roadmap

- [x] Recursive JSONL scan with incremental mtime skip
- [x] SQLite schema + upsert pipeline
- [x] SessionStart / PreToolUse:Bash / Stop hooks
- [x] Interactive groups wizard (no JSON editing)
- [x] Markdown reports grouped by company → product
- [x] Health check
- [x] `reef report-bug` — prefilled GitHub issue from sanitised logs
- [x] Tighten nudge regex (no more `tail -n` / heredoc false positives)
- [x] **MCP server** — Claude invokes reef tools directly, no terminal needed
- [ ] Ink-based TUI dashboard (`reef` with no args)
- [ ] Publish to npm
- [ ] Optional cross-machine config sync

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

*Built for developers who live in Claude Code and want their tools to think the way they do.*

</div>
