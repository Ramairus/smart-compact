import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brief, Grant, PendingCompact } from '../types'

const PLUGIN = 'smart-auto-compact'
const COMPACT_TOOL = `mcp__${PLUGIN}__compact`

const grant = atom({ plugin: 'smart-auto-compact', key: 'grant' } as const, null as Grant | null)
const brief = atom({ plugin: 'smart-auto-compact', key: 'brief' } as const, null as Brief | null)
const pending = atom({ plugin: 'smart-auto-compact', key: 'pending' } as const, null as PendingCompact | null)
const skills = atom({ plugin: 'smart-auto-compact', key: 'skills' } as const, [] as string[])
const turns = atom({ plugin: 'smart-auto-compact', key: 'turns' } as const, 0)
// Main-loop tool calls since the brief was last saved.
const sinceBrief = atom({ plugin: 'smart-auto-compact', key: 'sinceBrief' } as const, 0)
// The full text each of our tool rows shows under ctrl+o, by tool_use_id.
const shown = atom({ plugin: 'smart-auto-compact', key: 'shown' } as const, {} as Record<string, string>)

const SKILL_PERMISSION = /^\s*compact-permission:\s*granted\s*$/im
const RETRIES = 5

// A user copy at ~/.claude/skills/smart-auto-compact/SKILL.md overrides the bundled skill.
async function rulesPaths($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const bundled = `${$.plugin.root}/skills/smart-auto-compact/SKILL.md`
  return home ? [`${home.replace(/\\/g, '/')}/.claude/skills/smart-auto-compact/SKILL.md`, bundled] : [bundled]
}

// The "## Always keep" section of the smart-auto-compact skill, or "" when the skill is missing.
export function alwaysKeep(skillText: string): string {
  const match = /^##\s+Always keep\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(skillText)
  return match?.[1]?.trim() ?? ''
}

async function readRules($: EngineInterface): Promise<string> {
  for (const path of await rulesPaths($)) {
    try {
      return alwaysKeep(await $.fs.read(path))
    } catch {
      // Missing or unreadable: try the next one.
    }
  }
  return ''
}

export function composeInstructions(rules: string, loaded: readonly string[], extra?: string): string {
  const parts = []
  if (rules) parts.push(`Always keep:\n${rules}`)
  if (loaded.length) parts.push(`Skills loaded this session (keep their active rules): ${loaded.join(', ')}`)
  if (extra?.trim()) parts.push(extra.trim())
  return parts.join('\n\n')
}

export function briefSection(saved: Brief | null, now: number): string {
  if (!saved?.instructions.trim()) return ''
  const age = now - saved.turn
  const when = age <= 0 ? 'this turn' : `${age} turn${age === 1 ? '' : 's'} ago`
  return `Claude's task brief (written ${when}; newer conversation wins where they differ):\n${saved.instructions.trim()}`
}

export type Verdict = { valid: boolean; why: string }

// The judge's reply: VALID or STALE first, then one line of why. Anything else counts as stale.
export function parseVerdict(text: string): Verdict {
  const match = /^\W*(VALID|STALE)\b[\s\-–—:.*_]*(.*)/i.exec(text.trim())
  if (!match) return { valid: false, why: 'the check gave no clear answer' }
  return { valid: match[1]!.toUpperCase() === 'VALID', why: match[2]!.split('\n')[0]!.trim() }
}

export function judgePrompt(held: Grant, age: number, reason: string): string {
  return [
    '[smart-auto-compact permission check. Do not call tools; reply with one line.]',
    `Earlier, permission to compact this conversation without asking the user was granted for: "${held.scope}"`,
    `(granted by ${held.source === 'user' ? 'the user' : held.source}, ${age} turn${age === 1 ? '' : 's'} ago).`,
    `Claude now wants to compact because: "${reason}".`,
    'Judge from the conversation: is the current work still the work that permission covered,',
    'and has the user said nothing since that withdraws, narrows or contradicts it?',
    'A permission from a skill covers only the work that skill was loaded for.',
    'Reply VALID or STALE, then " - " and a short reason.',
  ].join('\n')
}

// At most four words; a grant saved before labels existed falls back to its scope.
export function grantLabel(held: Grant): string {
  const words = (held.label?.trim() || held.scope).split(/\s+/).filter(Boolean)
  return words.slice(0, 4).join(' ') + (words.length > 4 ? '…' : '')
}

function showStatus($: EngineInterface, held: Grant | null) {
  $.ui.status(held ? `compact grant: ${grantLabel(held)}` : undefined)
}

async function setGrant($: EngineInterface, next: Grant | null) {
  await update($, grant, () => next)
  showStatus($, next)
}

// The first line of a long input, cut short for the tool row.
export function clip(text: string, max = 48): string {
  const whole = text.trim()
  const line = whole.split('\n')[0]!
  return line.length > max || line !== whole ? `${line.slice(0, max).trimEnd()}…` : line
}

export const BRIEF_COMMAND = 'compact-brief'
const SHOW = `/${BRIEF_COMMAND} to show`

// What the call row of one of our tools shows: the tool's name, and for compact and
// request_grant one short field. Briefs, scopes and instructions are read in the pane.
export function shortInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool.endsWith('__compact') && typeof input.reason === 'string') return { reason: clip(input.reason) }
  if (tool.endsWith('__request_grant') && typeof input.label === 'string') return { label: input.label }
  return {}
}

// The tool's output with its text replaced for display, or undefined when the shape is unknown.
export function withDisplayText(output: unknown, text: string): unknown {
  if (typeof output === 'string') return text
  const blocks = Array.isArray(output) ? output : (output as { content?: unknown } | null)?.content
  if (!Array.isArray(blocks)) return undefined
  const first = blocks.findIndex(b => b?.type === 'text')
  if (first < 0) return undefined
  const next = blocks.flatMap((b, i) => (b?.type !== 'text' ? [b] : i === first ? [{ ...b, text }] : []))
  return Array.isArray(output) ? next : { ...(output as object), content: next }
}

const SHOWN_KEEP = 50

// The one line a call's result row shows in place of the model's result.
async function remember($: EngineInterface, id: string | undefined, text: string) {
  if (!id) return
  await update($, shown, map => Object.fromEntries([...Object.entries(map), [id, text]].slice(-SHOWN_KEEP)))
}

export function briefReminder(calls: number, hasBrief: boolean): string {
  return hasBrief
    ? `[smart-auto-compact] Your task brief was saved ${calls} tool calls ago. If the work has moved on since (a step finished, a decision made, a new next step), replace it now with set_compact_brief; otherwise carry on.`
    : '[smart-auto-compact] A compact grant is active but no task brief is saved. Save one now with set_compact_brief so an autocompact keeps the task state.'
}

// Whether the grant still covers this compaction: past its age limit it lapses, otherwise
// the session's own model judges it over the conversation unless the user chose to trust grants.
async function grantStands(
  $: EngineInterface,
  held: Grant,
  reason: string,
  options: { grantCheck: string; grantMaxTurns: number },
): Promise<Verdict> {
  const age = (await read($, turns)) - held.turn
  if (options.grantMaxTurns > 0 && age > options.grantMaxTurns)
    return { valid: false, why: `granted ${age} turns ago, over the ${options.grantMaxTurns}-turn limit` }
  if (options.grantCheck === 'trust') return { valid: true, why: 'grants are trusted' }
  const reply = await $.model.fork({ prompt: judgePrompt(held, age, reason) })
  if (!reply.isAnswered) return { valid: false, why: `the check could not run (${reply.reason})` }
  return parseVerdict(reply.text)
}

async function afterCompaction($: EngineInterface) {
  await update($, sinceBrief, () => 0)
  const loaded = await read($, skills)
  const note = [
    'The conversation was just compacted.',
    'CLAUDE.md is reloaded automatically.',
    loaded.length
      ? `Skills loaded before compaction: ${loaded.join(', ')}. Re-invoke any you still need with the Skill tool before continuing work that depends on them.`
      : '',
    (await read($, grant)) ? 'A compact grant is active: refresh the task brief with set_compact_brief once you are oriented.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
}

function runPending($: EngineInterface, job: PendingCompact, attempt = 0) {
  $.clock.after(attempt === 0 ? 250 : 2000, async () => {
    try {
      const done = await $.session.compact({ instructions: job.instructions })
      if (done.skip !== undefined) {
        $.ui.toast(`Compaction skipped: ${done.skip}`)
        return
      }
      await afterCompaction($)
      if (job.resume) await $.prompt.submit({ text: `Continue after compaction: ${job.resume}` })
    } catch (error) {
      if (attempt < RETRIES) runPending($, job, attempt + 1)
      else $.ui.log(`${PLUGIN}: compaction failed: ${String(error)}`)
    }
  })
}

const WINDOWS = [200_000, 150_000, 100_000]
const WINDOW_ASKED = 'windowAsked'

export const kTokens = (n: number) => `${Math.round(n / 1000)}k`

// Up to two autocompact windows below the current one, the larger first.
export function windowChoices(current: number): number[] {
  return WINDOWS.filter(w => w < current).slice(0, 2)
}

// Once per install: offer to lower the autocompact window, unless the user already set one.
// The change goes through /autocompact, which saves it to user settings and applies it now.
async function offerWindow($: EngineInterface) {
  if (await $.store.get(WINDOW_ASKED)) return
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (!breakdown) return
  const choices = windowChoices(breakdown.rawMaxTokens)
  if (breakdown.autocompactSource === 'env' || breakdown.autocompactSource === 'settings' || !choices.length) {
    await $.store.set(WINDOW_ASKED, true)
    return
  }
  const labels = choices.map((w, i) => (i === 0 ? `${kTokens(w)} (recommended)` : kTokens(w)))
  let answer: string
  try {
    answer = await $.ui.ask(
      `smart-auto-compact: autocompact runs near ${kTokens(breakdown.rawMaxTokens)} tokens. ` +
        "An earlier compaction keeps Claude's task brief closer to the work it summarizes. Lower the window?",
      { options: [...labels, 'Keep current', 'Ask next session'], header: 'Autocompact' },
    )
  } catch {
    return // Dismissed or no one to ask: offer again next session.
  }
  if (answer === 'Ask next session') return
  await $.store.set(WINDOW_ASKED, true)
  const chosen = choices[labels.indexOf(answer)]
  if (chosen === undefined) return
  const { text } = await $.command.run({ command: 'autocompact', args: kTokens(chosen) })
  $.ui.toast(text ?? `Autocompact window set to ${kTokens(chosen)}. Change it with /autocompact.`)
}

const STRING = { type: 'string' }

export const register: Register = (on, options) => {
  const check = {
    grantCheck: String(options.grantCheck ?? 'judge'),
    grantMaxTurns: Number(options.grantMaxTurns ?? 30),
  }
  const briefEvery = Number(options.briefReminderCalls ?? 25)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'compact',
      description:
        'Compacts this conversation once the current turn ends, like /compact <instructions>. ' +
        'Load the smart-auto-compact skill first for the rules. Runs without asking only while a grant is active ' +
        'and still judged to cover the current work; otherwise the permission mode decides (the auto-mode ' +
        'classifier, or the user). With `resume`, a prompt continuing the work is submitted after compaction.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { ...STRING, description: 'What the summary must keep: task state, decisions, next steps.' },
          reason: { ...STRING, description: 'One line for the user on why now.' },
          resume: { ...STRING, description: 'Optional. What to continue with after compaction.' },
        },
        required: ['instructions', 'reason'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_compact_brief',
      description:
        'Saves what any later compaction must keep (task, progress, decisions, next step), without compacting. ' +
        'Used by autocompact, which can run mid-turn, and by /compact. Replace it whenever a step finishes or a decision is made.',
      inputSchema: {
        type: 'object',
        properties: { instructions: { ...STRING, description: 'The current task state, as for compact.' } },
        required: ['instructions'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'request_grant',
      description:
        'Asks the user, ahead of a large task, for permission to compact without asking each time until release_grant.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { ...STRING, description: 'The task the grant covers.' },
          label: { ...STRING, description: 'Three or four words naming that task, for the status line.' },
        },
        required: ['scope', 'label'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'release_grant',
      description: 'Ends the active compact grant once the task it covered is done.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.command.register({
      name: BRIEF_COMMAND,
      description: "Show Claude's task brief and the compact grant in a pane",
      immediate: true,
    })
    showStatus($, await read($, grant))
    // Off the start path: the question waits for the UI, and /autocompact for an idle session.
    $.clock.after(1500, () => offerWindow($).catch(error => $.ui.log(`${PLUGIN}: window offer failed: ${String(error)}`)))
    return next(e)
  })

  // The permission decision for compact. A grant that still stands allows it; a lapsed or
  // stale one is withdrawn, and the call goes to the mode's decider: the auto-mode
  // classifier, which reads the conversation and the call's reason, or the user's dialog.
  on('tool.check', { tool: COMPACT_TOOL }, async ($, e, next) => {
    const engine = await next(e)
    if (engine.decision === 'deny' || (engine.decision === 'allow' && engine.rule)) return engine
    const held = await read($, grant)
    if (!held) return { decision: 'ask', reason: 'No compact grant is active.' }
    const { reason = '' } = (e.input ?? {}) as { reason?: string }
    const verdict = await grantStands($, held, reason, check)
    if (verdict.valid) return { decision: 'allow', reason: `Compact grant (${held.scope}): ${verdict.why}` }
    await setGrant($, null)
    $.ui.toast(`Compact grant withdrawn: ${verdict.why}`)
    return { decision: 'ask', reason: `The compact grant for "${held.scope}" no longer applies: ${verdict.why}` }
  }).catch(() => ({ decision: 'ask' as const, reason: 'The compact grant check failed.' }))

  // The other tools change nothing the user has not been asked about, or ask themselves.
  for (const name of ['set_compact_brief', 'request_grant', 'release_grant'])
    on('tool.check', { tool: `mcp__${PLUGIN}__${name}` }, () => ({ decision: 'allow' as const }))

  on('tool.call', { tool: COMPACT_TOOL }, async ($, e) => {
    const input = e as unknown as { instructions: string; reason: string; resume?: string }
    const job: PendingCompact = {
      instructions: composeInstructions(await readRules($), await read($, skills), input.instructions),
      resume: input.resume,
    }
    await update($, pending, () => job)
    const turn = await read($, turns)
    await update($, brief, () => ({ instructions: input.instructions, turn }))
    await update($, sinceBrief, () => 0)
    await remember($, e.tool_use_id, `Compaction queued · ${SHOW}`)
    return {
      result:
        'Compaction queued for the end of this turn. End the turn now' +
        (input.resume ? '; the work resumes automatically afterwards.' : '.'),
    }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__set_compact_brief` }, async ($, e) => {
    const { instructions } = e as unknown as { instructions: string }
    const turn = await read($, turns)
    await update($, brief, () => ({ instructions, turn }))
    await update($, sinceBrief, () => 0)
    await remember($, e.tool_use_id, `Brief saved · ${SHOW}`)
    return { result: 'Brief saved. The next compaction keeps it, including an autocompact mid-turn.' }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__request_grant` }, async ($, e) => {
    const { scope, label } = e as unknown as { scope: string; label?: string }
    if (await read($, grant)) return { result: 'A compact grant is already active.' }
    let answer: string
    try {
      answer = await $.ui.ask(`Allow Claude to compact without asking during: ${scope}?`, {
        options: ['Allow', 'Ask each time'],
        header: 'Compact',
      })
    } catch {
      return { deny: 'The user dismissed the grant request.' }
    }
    if (answer !== 'Allow') return { deny: `Not granted. The user answered: ${answer}` }
    const held: Grant = { scope, label, source: 'user', turn: await read($, turns) }
    await setGrant($, held)
    await update($, sinceBrief, () => 0)
    await remember($, e.tool_use_id, `Grant active · ${SHOW}`)
    return { result: `Compact grant active: ${grantLabel(held)}. Keep the task brief current with set_compact_brief.` }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__release_grant` }, async $ => {
    await setGrant($, null)
    return { result: 'Compact grant released.' }
  })

  // While a grant is active or a brief is saved, every briefEvery main-loop tool calls the model
  // gets a reminder, which the user never sees, to bring its brief up to date.
  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    if (briefEvery <= 0 || e.agentId || out.deny !== undefined || e.tool.startsWith(`mcp__${PLUGIN}__`)) return out
    const saved = await read($, brief)
    if (!saved && !(await read($, grant))) return out
    const calls = (await read($, sinceBrief)) + 1
    if (calls < briefEvery) {
      await update($, sinceBrief, () => calls)
      return out
    }
    await update($, sinceBrief, () => 0)
    return { ...out, context: [...(out.context ?? []), briefReminder(calls, saved !== null)] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const { tool, input } = e.props
    if (!tool.startsWith(`mcp__${PLUGIN}__`) || typeof input !== 'object' || !input) return next(e)
    return next({ ...e, props: { ...e.props, input: shortInput(tool, input as Record<string, unknown>) } })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!e.props.tool.startsWith(`mcp__${PLUGIN}__`) || e.props.isErrored) return next(e)
    const text = (await read($, shown))[e.props.tool_use_id]
    const output = text === undefined ? undefined : withDisplayText(e.props.output, text)
    return output === undefined ? next(e) : next({ ...e, props: { ...e.props, output } })
  }).catch(($, e, next) => next(e))

  // A pane, not command output: the model reads a command's text, and the brief is already its own.
  on('command.run', { command: BRIEF_COMMAND }, async $ => {
    await $.ui.open({ id: BRIEF_COMMAND, title: 'Compact brief', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: BRIEF_COMMAND }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [saved, held, now] = [await read($, brief), await read($, grant), await read($, turns)]
    return (
      <Box flexDirection="column">
        {held ? (
          <Text>
            <Text bold>Grant: </Text>
            {held.scope}
          </Text>
        ) : (
          <Text dimColor>No compact grant is active.</Text>
        )}
        <Text> </Text>
        {saved?.instructions.trim() ? (
          <Text>{briefSection(saved, now)}</Text>
        ) : (
          <Text dimColor>No task brief is saved.</Text>
        )}
        <Text dimColor>Esc to close</Text>
      </Box>
    )
  })

  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    await update($, skills, list => (list.includes(e.skill) ? list : [...list, e.skill]))
    if (SKILL_PERMISSION.test(out.text)) {
      const held = await read($, grant)
      const source = `skill:${e.skill}`
      // A skill grants when none is active, and renews its own grant when loaded again.
      if (!held || held.source === source) {
        await setGrant($, { scope: `skill ${e.skill}`, label: e.skill, source, turn: await read($, turns) })
        if (!held) $.ui.toast(`Compact permission granted by skill ${e.skill}`)
      }
    }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if ('agentId' in e && e.agentId) return out
    await update($, turns, n => n + 1)
    const job = await read($, pending)
    if (job) {
      await update($, pending, () => null)
      if (e.reason === 'answer') runPending($, job)
      else $.ui.toast('Queued compaction dropped: the turn did not finish normally.')
    }
    return out
  })

  // Manual /compact and autocompact (which can run mid-turn) get the same rules and Claude's
  // latest brief; plugin compactions already carry fresh instructions.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'plugin') return next(e)
    const saved = briefSection(await read($, brief), await read($, turns))
    const instructions = composeInstructions(
      await readRules($),
      await read($, skills),
      [saved, e.instructions].filter(Boolean).join('\n\n'),
    )
    const out = await next({ ...e, instructions })
    if (out.skip === undefined && e.trigger !== 'precompute') {
      if (e.trigger === 'auto') $.ui.toast(saved ? "Auto-compacted with Claude's task brief" : 'Auto-compacted (no task brief saved)')
      await afterCompaction($)
    }
    return out
  }).catch(($, e, next) => next(e))
}
