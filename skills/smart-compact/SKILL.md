---
name: smart-compact
description: Rules for compacting this session's context with the smart-compact tools. Load before calling mcp__smart-compact__compact or request_grant, before starting a large multi-step task that may need compaction, or when the user types /smart-compact.
---

# Smart compact

The `smart-compact` plugin gives Claude four tools:

- `mcp__smart-compact__compact { instructions, reason, resume? }` queues a compaction. It runs after the current turn ends, never mid-turn. With `resume`, the plugin submits a prompt after compaction so the work continues by itself.
- `mcp__smart-compact__set_compact_brief { instructions }` saves what any later compaction must keep, without compacting. Autocompact, which can run mid-turn, and `/compact` both use it.
- `mcp__smart-compact__request_grant { scope, label }` asks the user once for permission to compact without asking, until the grant is released. `label` is three or four words naming the task (`gradle-port bundles 01-16`); the prompt footer shows it. Keep `scope` to one sentence.
- `mcp__smart-compact__release_grant` ends the grant.

## Permission

- Without a grant, `compact` goes to the permission mode's decider: the user's dialog, or in auto mode the classifier. Give a `reason` that stands on its own.
- Before a large task (many files, a bundle set, a long audit), call `request_grant` with the task as scope, before starting the work.
- A skill whose body has the line `SMART-COMPACT:REQUEST_GRANT: <context>` gets its grant from the plugin when it loads: the user is asked, or not at all once they chose "Always" or "Never" for that skill in this project. Don't call `request_grant` for that skill's work; the skill text ends with a note when its grant is active. A skill grant covers only the work the skill was loaded for.
- A grant from `request_grant` outranks a skill's: a skill loaded under it keeps it. `request_grant` while a skill's grant is active asks the user to widen it.
- A grant is not a blank cheque. Before each compaction under a grant, the session model judges from the conversation whether the grant still covers the current work, unless the user set grants to be trusted. A grant judged stale, or older than the user's turn limit, is withdrawn and the user sees why.
- Call `release_grant` when the task the grant covered is done.

## The task brief

- While a grant is active, or during any long task, keep a brief current with `set_compact_brief`: at the start of the work, whenever a step finishes or the user decides something, and again after a compaction once you are oriented. A brief that lags the work loses whatever happened since.
- The plugin reminds you after a run of tool calls with no new brief. When the work has moved on, replace the brief then; when nothing changed, carry on.
- The brief takes the same content as `instructions` below. Replace it whole each time; it is not a log.
- Autocompact can run in the middle of a turn without asking anyone. The brief is how what you know reaches that summary.

## When to compact

- Between phases of a large task, after the current phase's results are written to files, not in the middle of an edit.
- When earlier tool output (large file reads, search dumps, build logs) is no longer needed.
- Not when the user is mid-discussion and will refer back to recent details.
- After calling `compact`, end the turn right away with a one-line status.

## What to put in `instructions`

- The current task, what is done, what is next, in concrete terms (files, symbols, open questions).
- Decisions the user made in this session and the reasons, so they are not re-litigated.
- Anything not yet saved to a file (pending doc changes, findings).
- Use `resume` only when a grant is active or the user said to keep going.

## Always keep

This section is added to every compaction: the `compact` tool, manual `/compact`, and autocompact (with the task brief). A copy of this file at `~/.claude/skills/smart-compact/SKILL.md` overrides it.

- All rules from CLAUDE.md files and from the user's auto-memory that were in effect, and the Session Startup / Workflow Rules they impose.
- Every skill loaded this session by name, with the rules from it that are in play.
- The user's explicit instructions and corrections from this session, verbatim where short.
- The current task, its progress, and the next step.
- Unflushed pending doc changes.
