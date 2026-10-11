# smart-auto-compact

A Claude Code plugin that lets Claude compact its own context, with your approval, and applies the same "always keep" rules to every compaction: Claude's own, manual `/compact`, and autocompact.

## Install

```
/plugin marketplace add <owner>/smart-auto-compact
/plugin install smart-auto-compact@smart-auto-compact
```

## What it adds

- **Tools:** `compact`, `set_compact_brief`, `request_grant`, `release_grant` (as `mcp__smart-auto-compact__*`). A compaction runs after the current turn ends. It goes to your permission mode (your dialog, or the auto-mode classifier) unless a grant is active and still applies.
- **Mid-turn compaction:** autocompact already runs mid-turn without stopping the work. Claude keeps a task brief with `set_compact_brief`, and the plugin adds it to every autocompact, so what Claude knows survives. A toast says when one happened. You set when it runs with the autocompact window (`/autocompact`, `autoCompactWindow` in settings, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). On its first session the plugin offers to lower the window, unless you already set one. It asks once (or again next session if you pick "Ask next session") and applies your choice through `/autocompact`.
- **Grants that expire:** a grant from you or from a skill (a body line `compact-permission: granted`) doesn't hold forever. Before each compaction under a grant, the session model judges from the conversation whether the grant still covers the current work, and withdraws it if not. Grants also lapse after a set number of turns. While a grant is active, the status line names its task in a few words (`compact grant: gradle-port bundles 01-16`).
- **Quiet transcript:** the rows of the plugin's tools show their inputs cut to one short line. The full brief, scope or instructions are in the result row, folded until you press ctrl+o.
- **Brief reminders:** while a grant is active or a brief is saved, Claude gets a reminder you don't see after a run of tool calls with no new brief, so the brief keeps up with the work.
- **Skill:** `smart-auto-compact`, which tells Claude when and how to compact. Its `## Always keep` section is added to every compaction. To use your own rules, copy it to `~/.claude/skills/smart-auto-compact/SKILL.md` and edit it.

After a compaction, Claude is reminded which skills were loaded so it can load them again.

## Options

Set in `/config` or under `pluginConfigs` in settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `grantCheck` | `judge` | `judge`: check each grant against the conversation before using it. `trust`: an active grant always applies. |
| `grantMaxTurns` | `30` | Turns after which a grant lapses whatever the check says. `0` for no limit. A skill renews its grant when it is loaded again. |
| `briefReminderCalls` | `25` | Tool calls with no new brief before Claude is reminded to update it. `0` to turn off. |

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
