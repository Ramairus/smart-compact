---
name: smart-compact
description: How to use the smart-compact tools well, and how to build them into other skills. Load before calling mcp__smart-compact__compact or request_grant, before a large multi-step task that may need compaction, when a loaded skill shows a SMART-COMPACT:REQUEST_GRANT line or asks you to follow this skill, when writing or editing a skill whose work runs long (many phases or units, or unattended), or when the user types /smart-compact.
---

# Smart compact

The `smart-compact` plugin gives Claude four tools:

- `mcp__smart-compact__compact { instructions, reason, resume? }` queues a compaction. It runs after the current turn ends, never mid-turn. With `resume`, the plugin submits a prompt after compaction so the work continues by itself.
- `mcp__smart-compact__set_compact_brief { instructions }` saves what any later compaction must keep, without compacting. Autocompact, which can run mid-turn, and `/compact` both use it.
- `mcp__smart-compact__request_grant { scope, label, skill?, ask? }` asks for permission to compact without asking, until the grant is released. `label` is three or four words naming the task (`gradle-port bundles 01-16`); the prompt footer shows it. Keep `scope` to one sentence. `skill` passes on a loaded skill's own request (see "Skill requests"). `ask: false` never opens a dialog.
- `mcp__smart-compact__release_grant` ends the grant.

## Permission

- Without a grant, `compact` goes to the permission mode's decider: the user's dialog, or in auto mode the classifier. Give a `reason` that stands on its own.
- A grant from `request_grant` outranks a skill's: a skill loaded under it keeps it. `request_grant` while a skill's grant is active asks the user to widen it.
- A grant is not a blank cheque. Before each compaction under a grant, the session model judges from the conversation whether the grant still covers the current work, unless the user set grants to be trusted. A grant judged stale, or older than the user's turn limit, is withdrawn and the user sees why.
- Release only a grant you or the current skill obtained, once the work it covers ends. A grant that was already active when you asked ("A compact grant is already active") belongs to an enclosing task: leave it.

### Dialogs

Some calls stop the work until the user answers a dialog: `request_grant` (unless a grant already applies, `ask` is false, or a saved "Always" or "Never" decides it), and `compact` without a grant outside auto mode. Silent and always fine: `set_compact_brief`, `release_grant`, and `request_grant` with `ask: false`.

- **The user hasn't brought up smart-compact.** Cause no dialog. Keep a brief with `set_compact_brief` so autocompact keeps the task, and leave compaction to autocompact. `request_grant` and your own `compact` calls are for when the user asked for them, agreed when you offered, or a loaded skill asks for a grant with its request line. A user who put that line in a skill has opted in for that skill's work.
- **The user asked you to work on your own, unattended, or not to be interrupted, or a question would stall a large task with nobody watching.** Pass `ask: false`. If that grants nothing, don't ask. Call `compact` when it is due and let the permission mode decide: in auto mode the classifier, never a dialog.
- **You are a subagent.** The plugin never asks from a subagent (see "Subagents").
- Otherwise, before a large task the user wants compacted as it goes (many files, a bundle set, a long audit), call `request_grant` once, with the whole task as scope, before starting the work.

### Skill requests

A skill asks for a grant with the line `SMART-COMPACT:REQUEST_GRANT: <context>` in its body. Normally the plugin reads that line as the skill loads, removes it, and either asks the user or applies their saved "Always" or "Never". The skill text then ends with `[smart-compact] A compact grant covers this skill's work.` when the grant is active. A grant from a skill covers only the work the skill was loaded for. Never call `request_grant` for a grant of your own on top of a skill's.

Where an organization manages Claude Code, the plugin is not called when a skill loads, so nothing reads the line. You can tell because the line is still in the skill text you were given. Then do it yourself, once per load, before the skill's work:

- Call `request_grant` with `skill` set to the skill's name as the Skill tool names it, `scope` set to the text after `SMART-COMPACT:REQUEST_GRANT:`, and `label` set to the skill's name or three or four words for its task. Follow "Dialogs" for `ask`.
- The plugin applies it exactly as on load: the user's saved "Always" grants without a dialog, "Never" refuses without one, and otherwise the user gets the same Allow, Always, Not now or Never dialog.
- A skill that says not to call `request_grant` means a grant of your own for its work. Passing on its own request line with `skill` is how that line takes effect, so do it anyway.
- Ignore a request line quoted as an example, or inside a code block.

The same organizations also skip the plugin when autocompact or a manual `/compact` runs, so those compactions get neither the "Always keep" rules nor your brief. To make up for that, compact with `compact` at the work's natural boundaries, before autocompact would, so the summary gets your instructions. After any compaction you did not request, load the skills you were using again.

## Where smart-compact works best

What it adds: you choose when the context is compacted and what the summary must keep, the work can pick itself back up afterwards, every compaction (autocompact too) carries your brief, and a grant lets all of this happen without stopping for the user.

What a compaction always loses is the conversation itself: exact tool output, wording, the path the reasoning took. What survives is the summary your instructions and brief steer, and whatever was written to files. So smart-compact is strongest where the work's real state lives outside the chat, and the chat only carries direction.

Signs of a good fit:

- **The state is in files.** A plan, a checklist, task files, notes, a findings log. A compaction then only has to carry the session's direction (what the work is, where it stands, what the user decided, what is open), which is exactly what a brief does well. The summary being lossy doesn't matter, because nothing the next step needs exists only in the chat.
- **The work has natural boundaries.** Pieces finished one at a time: a bundle, a file, a module, a migration step, an audit phase. Compacting between pieces drops tool output that can no longer matter, and each piece starts with a clean context instead of one autocompact cut at an arbitrary moment.
- **It runs long or unattended.** Without a chosen moment, autocompact fires wherever the window fills, possibly mid-edit.

An example of a good system is a bundle workflow; "Example integration" below shows one in full.

Weaker fits: a discussion where the user refers back to recent details; work whose facts exist only in the conversation (write them down first, or rely on autocompact with a good brief); short tasks, where a compaction costs more than it saves.

When building it into a workflow, think about:

- what the boundaries are, and whether everything that matters is written down by the time each one is reached;
- what only the brief can carry: the user's decisions, open questions, the direction;
- how the work picks back up: the `resume` prompt, and which skills to load again after compaction;
- when to stop and release the grant: the work is done, or it waits on the user;
- whether the user is around (see "Dialogs").

When you do compact as part of such work, the usual order is: bring the files up to date, replace the brief, call `compact` with the same content as `instructions` (and `resume` when a grant is active), end the turn. Afterwards load the workflow's skills again and carry on from the files. Release the grant when the work it covered ends.

## Example integration

A `bundle-workflow` skill executes a set of task bundles under `.claude/tasks/<set>/`. An index orders the bundles. Each bundle file is self-contained: the files it may edit, its tasks as checkboxes with the problem, the fix and a "done when", and how to verify. Open questions go into the index as numbered decisions. This is the skill's whole compaction section:

```markdown
## Context management
SMART-COMPACT:REQUEST_GRANT: a bundle set, executed bundle by bundle, compacting after every bundle until the set is finished or waits on the user's answers

Compact after every finished bundle, never mid-bundle: tick its checkboxes and record blocked tasks in the index first. Resume with "continue the <set> bundle set with the bundle-workflow skill", unless questions wait for the user. After compaction, also load `code-standards`.
```

Why each part is there:

- **The request line** gets the grant: asked once when the skill loads, or decided by a saved "Always" or "Never". Its text becomes the grant's scope, which the check before each compaction compares with the conversation. So it names the work precisely, including when the work ends ("until the set is finished or waits on the user's answers"), and the grant lapses by itself after that.
- **"after every finished bundle, never mid-bundle"** is the boundary. It is safe because a finished bundle has nothing left that exists only in the chat.
- **"tick its checkboxes and record blocked tasks first"** is what makes it safe: the files are the handoff, so they are brought up to date before every compaction.
- **The resume prompt** names the target and the skill, so the fresh context knows what to load and where to look. "unless questions wait for the user" stops it running on when it shouldn't.
- **The extra skill to load** is specific to this workflow; the workflow's own skill is loaded again anyway.
- **What is left out** comes from this skill: the tool names, what the brief holds, dialogs, organizations, and when to release the grant.

How a run goes:

1. The user types `/bundle-workflow run AS`. The plugin reads the request line as the skill loads and asks once, or applies the saved choice. In an organization, Claude passes the line on with `request_grant { skill: "bundle-workflow", ... }` instead.
2. Claude reads the index, picks AS.1 and saves a first brief: set AS, executing AS.1, the decisions recorded so far.
3. Claude works through AS.1, ticking boxes as tasks finish and replacing the brief when the user decides something. If autocompact fires mid-bundle, the brief carries the direction and the checkboxes show the progress.
4. AS.1 is done. Claude reports, then replaces the brief: "Set AS: AS.1 done, AS.2 next. AS.D1 open (A or B). The user chose X for AS.D0." It calls `compact` with the same text as `instructions` and the resume prompt, and ends the turn.
5. The plugin checks the grant still covers the work, compacts, and submits the resume prompt. Claude loads `bundle-workflow` and `code-standards` again, reads the index, sees AS.1 checked, and starts AS.2 with a context that holds only the summary.
6. When every bundle is done, or nothing can go on without the user's answers, Claude calls `compact` without `resume` (or doesn't compact at all), releases the grant, and reports with the questions batched.

What the summaries lose here is AS.1's diffs, test output and the files it read. AS.2 needs none of it: what AS.2 needs is in its bundle file and the code. What must not be lost, which set this is, what the user decided and what is open, is in the brief and the index.

The same shape fits other work whose state lives in files: a migration done one module at a time against a checklist, an audit that appends findings to a file area by area, a long generation task that writes one document per step. What changes is the boundary, the files that hold the progress, and the resume prompt.

## Adding smart-compact to a skill

When you write or edit a skill, consider whether its work fits (see "Where smart-compact works best", and "Example integration" for the shape).

- **Bring it up only for a good fit.** For a short skill, a reference skill, or one that answers in a single turn, don't.
- **Ask first.** In one or two lines of your reply, not a dialog, say what it would add for this skill and that the first load asks the user once (Allow, Always, Not now or Never; "Always" stops it asking in that project). Add it only once the user agrees. A no stands for that skill.
- **Keep the user's section short.** This skill is loaded alongside it, so the skill needs only its request line and what is specific to its own work:

  ```markdown
  ## Context management
  SMART-COMPACT:REQUEST_GRANT: <the work, in one line>

  <Where this work's boundaries are, and how it picks back up.>
  ```

- **Don't restate this skill** in the user's skill: the tools, the brief, dialogs, or what to do in an organization. If an existing skill does, offer to shorten its section, and show the result before writing it.
- `compact-permission: granted` in a skill grants without asking at all. Write it only when the user asks for exactly that.

## Subagents

- A subagent starts with its own copy of the grant held by whoever started it. Releasing one leaves the other.
- `compact` and `set_compact_brief` refuse in a subagent: the plugin can compact only the main conversation. Put what must survive in files or in the final report.
- A subagent never asks the user: `request_grant` there only reports the grant it already holds, or applies a saved "Always".

## The task brief

- While a grant is active, or during any long task, keep a brief current with `set_compact_brief`: at the start of the work, whenever a step finishes or the user decides something, and again after a compaction once you are oriented. A brief that lags the work loses whatever happened since.
- The plugin reminds you after a run of tool calls with no new brief. When the work has moved on, replace the brief then; when nothing changed, carry on.
- The brief takes the same content as `instructions` below. Replace it whole each time; it is not a log.
- Autocompact can run in the middle of a turn without asking anyone. The brief is how what you know reaches that summary.

## When to compact

- Between units or phases of a large task, after the current one's results are written to files, not in the middle of an edit.
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
