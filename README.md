# smart-compact

A Claude Code plugin that lets Claude compact its own context, with your approval, and applies the same "always keep" rules to every compaction: Claude's own, manual `/compact`, and autocompact.

## Install

```
/plugin marketplace add Ramairus/smart-auto-compact
/plugin install smart-compact@smart-compact
```

## What it adds

- **Tools:** `compact`, `set_compact_brief`, `request_grant`, `release_grant` (as `mcp__smart-compact__*`). A compaction runs after the current turn ends. It goes to your permission mode (your dialog, or the auto-mode classifier) unless a grant is active and still applies.
- **Mid-turn compaction:** autocompact already runs mid-turn without stopping the work. Claude keeps a task brief with `set_compact_brief`, and the plugin adds it to every autocompact, so what Claude knows survives. A toast says when one happened. You set when it runs with the autocompact window (`/autocompact`, `autoCompactWindow` in settings, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). On its first session the plugin offers to lower the window, unless you already set one. It asks once (or again next session if you pick "Ask next session") and applies your choice through `/autocompact`.
- **Skill grants:** a skill asks for a grant with one line anywhere in its body:

  ```
  SMART-COMPACT:REQUEST_GRANT: <short context for the grant>
  ```

  The plugin reads that line itself each time the skill loads, so it doesn't depend on Claude calling a tool, and removes it from what Claude reads. The first time, you're asked: `Allow` (this load), `Always for <skill>`, `Not now`, or `Never for <skill>`. `Always` and `Never` are saved for this project, across sessions: later loads grant without asking, or are refused without asking. `/compact-brief` lists the project's saved choices with a Remove button each; removing an `Always` also ends that skill's active grant, and removing a `Never` makes the skill ask again. The older line `compact-permission: granted` still grants without asking.
- **Grants never downgrade:** a grant you gave through `request_grant` covers the session's task and outranks a skill's. A skill loaded while it's active keeps it and doesn't ask. `request_grant` while a skill grant is active asks to widen it. A skill's grant gives way to the next skill that requests one.
- **Grants that expire:** a grant from you or from a skill doesn't hold forever. Before each compaction under a grant, the session model judges from the conversation whether the grant still covers the current work, and withdraws it if not. Grants also lapse after a set number of turns. While a grant is active, the prompt footer names its task in a few words (`smart-compact: gradle-port bundles 01-16`).
- **Quiet transcript:** the plugin's tool calls show as their name and one short line (`Brief saved · /compact-brief to show`). `/compact-brief` opens a pane with the current brief, grant scope and saved skill choices, even while Claude is working; Esc closes it. The model doesn't see the pane.
- **Brief reminders:** while a grant is active or a brief is saved, Claude gets a reminder you don't see after a run of tool calls with no new brief, so the brief keeps up with the work.
- **Skill:** `smart-compact`, which tells Claude when and how to compact. Its `## Always keep` section is added to every compaction. To use your own rules, copy it to `~/.claude/skills/smart-compact/SKILL.md` and edit it.

After a compaction, Claude is reminded which skills were loaded so it can load them again.

## Options

Set in `/config` or under `pluginConfigs` in settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `grantCheck` | `judge` | `judge`: check each grant against the conversation before using it. `trust`: an active grant always applies. |
| `grantMaxTurns` | `30` | Turns after which a grant lapses whatever the check says. `0` for no limit. A skill renews its own grant when it is loaded again. |
| `briefReminderCalls` | `25` | Tool calls with no new brief before Claude is reminded to update it. `0` to turn off. |

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
