# cc-reef — Postmortem

**Status:** ❌ Project failed and archived (2026-04-30)
**Author:** Isaam (with Claude Code as collaborator)
**Use this doc to:** avoid the same mistakes the next time you reach for "build a tool around an LLM."

---

## What cc-reef was supposed to be

A per-project, always-on **senior architect** that maintained alignment between docs and code:

- Reads your project docs (TTDs, PRDs, ADRs)
- Cross-checks them against the actual codebase
- Surfaces drifts (code-fails-doc / doc-stale)
- Proposes fixes via a tracked Action Plan
- You approve, it applies, doc and code stay aligned over time

The vision was correct. The execution was not.

---

## What worked (keep these ideas for the next attempt)

1. **The truth hierarchy.** Code + git → living-truth files (CLAUDE.md, drift logs, ADRs) → docs. Docs are aspirational; code is real; living-truth bridges intent. This mental model is right and survives the project failure.
2. **The four-verdict audit model.** `pass / code-fails-doc / doc-stale / unverifiable`. Each verdict maps to a different remediation. This is the right primitive for any code-vs-doc tool.
3. **The Action Plan as lightweight task tracking.** JSONL-on-disk, per project, no separate DB. Sound storage shape.
4. **Sandboxed file/code access** with an explicit allowlist of project paths. Architecturally fine. The bugs were in path-resolution edge cases, not the model.
5. **Living-truth-first methodology.** Reading `CLAUDE.md` and recent git log *before* judging doc claims is the difference between grounded and hallucinated reviews.
6. **The dual-LLM verification loop.** Grok proposed, Claude Code reviewed, Claude caught the bugs. This *is* the right pattern — but it should be inside the user's existing IDE, not a separate web app.
7. **Theme system / accessibility pass / chat polish.** All correctly built; none of it saved the project, because the underlying value prop was broken.

---

## What didn't work (the actual mistakes)

### 1. Wrong delivery vehicle

Built as a standalone Node web app + xAI Grok integration. The user (solo dev, single project, Claude Max plan) was *already* running Claude Code in their IDE for the same workflow.

**Result:** every interaction required a context switch (browser ↔ IDE), every action had to be plumbed through tool calls Grok kept getting wrong, and we paid xAI tokens for work Claude was already doing for free.

**The right call would have been:** a Claude Code skill (one Markdown file at `.claude/skills/audit-doc.md`) that defines the audit playbook. Claude follows it natively, edits files natively, runs git natively. No separate UI, no second LLM, no plumbing.

### 2. LLM tool-call plumbing was fundamentally fragile

Text-based tool calls (`<tool>NAME</tool>{json}`) require the model to:
- Use the correct wrapper syntax
- Use the right argument names
- Stay within token budget for inline JSON
- Not contradict its own system prompt

Grok-3 and grok-4-fast-reasoning failed at one or more of these in nearly every non-trivial case:
- Refused with "I can't modify files" despite explicit permission grants in the prompt
- Used arg names like `name` / `content` instead of `docRef` / `newBody`
- Inlined entire 24K-character doc bodies as JSON args, hit the 4K output cap, truncated mid-stream → parser couldn't extract a complete tool call → silent fail
- Emitted bare-format calls (`update_doc {...}`) instead of wrapped (`<tool>update_doc</tool>{...}`)

Each of these got patched (loose parser, alt-arg-name tolerance, prompt rewrites, bigger token budgets) and a new failure mode appeared. **Patching symptoms, not the root cause.**

**The root cause:** asking an LLM to emit large structured payloads as part of a streamed completion, then parsing them out of text, is not a robust integration pattern. Either use the provider's native function-calling (`tools` parameter with schemas), or — better — use a model whose tool integration is provider-managed end-to-end (Claude Code with native tools).

### 3. Prompt drift across multiple presets

We had three system prompts (default, Architect Mode, Audit Mode) that evolved separately, plus per-chat overrides that froze stale copies. They contradicted each other:

- Default said *"output unified diffs, never claim a file is updated"*
- New tools said *"YOU HAVE PERMISSION to call `update_doc`"*
- Architect Mode appended its own rules, refTail spliced in defaults, overrides froze old versions

The model honoured whichever instruction was most cautious. Took 4+ iterations and a "preset refresh" banner to make the prompt usable, and it still wasn't reliable.

**The lesson:** one prompt, one source of truth, no overrides. Or move the "rules" into a skill file the model reads as part of the task, not a system message.

### 4. Confidently-wrong reviews — the canonical incident

Grok audited Lumi's `08-module-lumi.md`, didn't see a `flows/` subtree on disk, and flagged "missing flows/ sub-module" as a high-priority gap with a proposed task to *Implement Structured Flows*. The user had **deliberately deleted that subtree weeks earlier** when migrating Lumi to LLM tool-calling, and logged the deletion in `CLAUDE.md`. Acting on the proposed task would have re-introduced the exact code the user just removed.

Root cause: the audit treated TTDs as the source of truth and skipped reading `CLAUDE.md` / drift log / git history. Claude Code (in the user's IDE) caught the error in seconds because it had native filesystem + git access.

**This was the moment that proved the wrong delivery vehicle.** A reviewer that can't read drift logs is worse than no reviewer.

### 5. Feature stacking before any feature was solid

In one session we shipped: chat with multiple sessions, model picker, theme system, drag-drop doc grouping, system-prompt editor, architect/audit mode presets, preset-refresh banner, Action Plan tab, alignment scan, alignment export, four new code-introspection tools, two new git tools, two new doc-write tools, four new task-tools, an audit prompt, a four-verdict audit model. Each was "almost working." None was bulletproof.

**The discipline I missed:** ship one feature end-to-end, verify it on real data 5 times, *then* add the next. The user said "push harder, ship a working product" — the right reading was "ship one thing well", not "ship many things half-done."

### 6. Patching symptoms instead of stepping back

When the third tool-call truncation happened, I added a fourth fallback parser. The right call was to stop and rethink the integration model — which is what we eventually did, but only after 8+ patch iterations and the user explicitly stepping back.

### 7. Sandbox path-resolution silently failed

The encoded project name `E--DXB-Superpowers` resolves to `E:\DXB-Superpowers` (with a dash). The user's actual folder is `E:\DXB_Superpowers` (with an underscore). The resolver returned `null`, the sandbox roots silently dropped the code repo, and `list_files` only returned doc files. The model then concluded "codebase not in sandbox" — wasting an entire session before the user mentioned the actual path. Fixed eventually (try dash, underscore, and concatenated joiners), but the root issue is that *silent failures in a sandbox layer become loud hallucinations downstream*.

### 8. Multiple overlapping LLM-handoff paths

Three different orchestration paths shipped in the same project — chat tool-loop, alignment-scan, apply-task-patch. Each made similar LLM calls with slightly different prompts and JSON schemas. They evolved independently and conflicted. **One orchestrator, one schema, one path** would have been worth more than three flexible ones.

---

## Why the project failed (one-line summary)

> We built a separate web app with a second LLM to do work the user's existing IDE assistant could do natively, more reliably, for free.

Everything else in this postmortem is a consequence of that single bet being wrong.

---

## Lessons for next time

1. **Match the tool to the existing workflow.** If the user is already in Claude Code daily, the new feature should live in Claude Code (skill / MCP / slash command), not a separate UI. Cost, reliability, and friction all favour native.
2. **Don't add a second LLM unless one can't do the job.** Claude Max plan + Claude Code already covers grounded code+doc audits. xAI added prompt drift, tool truncation, and cost without adding capability.
3. **One feature, end to end, verified, before the next.** Five working steps beats fifteen half-working ones.
4. **Living-truth before docs, code before living-truth.** Hardcode this rule. Any audit that reads only the doc is broken by construction.
5. **Don't parse LLM-emitted JSON out of streamed text.** Either use native tool calling with schemas, or accept that this integration model will leak.
6. **Silent fallbacks in any layer become loud hallucinations downstream.** Surface every "couldn't find / couldn't resolve / wrong arg name" loudly so the model can recover.
7. **One system prompt, one source of truth.** No presets, no overrides, no banners. Move "rules" into the task instructions, not the system message.
8. **Watch for "patching symptoms" mode.** The third bandaid on the same problem is the signal to stop and redesign.

---

## What replaces cc-reef

A **Claude Code skill** at `.claude/skills/audit-doc.md` that encodes the audit playbook:

1. Read `CLAUDE.md` + `AGENTS.md` + drift logs + ADRs first.
2. Read the target doc + its Revision History. If the history says "code is source of truth," weight accordingly.
3. Extract claims (concrete, verifiable; skip aspirational language).
4. Verify each claim with `Read` / `Grep` / `Bash git log`.
5. Per-claim verdict: pass / code-fails-doc / doc-stale / unverifiable.
6. Write findings to `.cc-reef/audits/<doc>-<timestamp>.md` so they persist + git-track.
7. User triages inline: "fix the code", "fix the doc", "skip" — Claude edits files natively.

Trigger: `/audit <docname>` in Claude Code.

This is Phase 1 of the rebuild. Implementation: one Markdown file. No web app. No second LLM. No tool plumbing.

---

## Final verdict

cc-reef was the right idea built in the wrong place with the wrong tools. The mental model survives. The implementation does not. Archived as a learning artifact.

— Isaam, 2026-04-30
