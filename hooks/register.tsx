import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Brief, Grant, PendingCompact, SkillChoices } from '../types'

const PLUGIN = 'smart-compact'
const COMPACT_TOOL = `mcp__${PLUGIN}__compact`

// Grants by agent loop: MAIN for the main conversation, a subagent's under its agentId.
const grants = atom({ plugin: 'smart-compact', key: 'grants' } as const, {} as Record<string, Grant>)
const MAIN = ''
const brief = atom({ plugin: 'smart-compact', key: 'brief' } as const, null as Brief | null)
const pending = atom({ plugin: 'smart-compact', key: 'pending' } as const, null as PendingCompact | null)
const skills = atom({ plugin: 'smart-compact', key: 'skills' } as const, [] as string[])
const turns = atom({ plugin: 'smart-compact', key: 'turns' } as const, 0)
// Main-loop tool calls since the brief was last saved.
const sinceBrief = atom({ plugin: 'smart-compact', key: 'sinceBrief' } as const, 0)
// The full text each of our tool rows shows under ctrl+o, by tool_use_id.
const shown = atom({ plugin: 'smart-compact', key: 'shown' } as const, {} as Record<string, string>)
// The session's copy of this project's skill choices kept in $.store, for the pane.
const choices = atom({ plugin: 'smart-compact', key: 'choices' } as const, { always: [], never: [] } as SkillChoices)
// Slash commands typed this session: a skill run as `/name` counts as loaded for request_grant.
const invoked = atom({ plugin: 'smart-compact', key: 'invoked' } as const, [] as string[])

const SKILL_PERMISSION = /^\s*compact-permission:\s*granted\s*$/im
const GRANT_REQUEST = /^[ \t]*SMART-COMPACT:REQUEST_GRANT[ \t]*:?[ \t]*(.*?)[ \t]*$/i
const FENCE = /^[ \t]*(```|~~~)/
const RETRIES = 5

// A skill's one-line grant request: its context, and the skill text without the line. A line
// inside a fenced code block is an example (the smart-compact skill shows one), not a request.
export function parseGrantRequest(text: string): { context: string; text: string } | undefined {
  let fenced = false
  let at = 0
  for (const line of text.split('\n')) {
    const end = at + line.length + 1
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced) {
      const match = GRANT_REQUEST.exec(line.replace(/\r$/, ''))
      if (match) return { context: match[1]!, text: text.slice(0, at) + text.slice(end) }
    }
    at = end
  }
  return undefined
}

// What a skill's load does to the grant held: a session grant from the user outranks any
// skill's and is never replaced by one; the skill's own grant is renewed; another skill's,
// equal in rank, gives way to the skill now loaded.
export function skillGrantAction(held: Grant | null, skill: string): 'grant' | 'renew' | 'keep' {
  if (!held) return 'grant'
  if (held.source === `skill:${skill}`) return 'renew'
  return held.source === 'user' ? 'keep' : 'grant'
}

// The store key for one project's skill choices; Windows paths compare without case.
export function choicesKey(root: string): string {
  const path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return `skills:${/^[a-z]:\//i.test(path) ? path.toLowerCase() : path}`
}

const names = (list: unknown): string[] => (Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [])

// Skills the user allowed, or refused, to grant on every load, in any session of this project.
async function loadChoices($: EngineInterface): Promise<SkillChoices> {
  const saved = (await $.store.get(choicesKey(await $.session.root()))) as Partial<SkillChoices> | undefined
  return { always: names(saved?.always), never: names(saved?.never) }
}

// Saves `choice` for `skill` in this project, or forgets the skill when it is undefined.
async function setChoice($: EngineInterface, skill: string, choice: keyof SkillChoices | undefined) {
  const { always, never } = await loadChoices($)
  const next: SkillChoices = {
    always: [...always.filter(s => s !== skill), ...(choice === 'always' ? [skill] : [])],
    never: [...never.filter(s => s !== skill), ...(choice === 'never' ? [skill] : [])],
  }
  const key = choicesKey(await $.session.root())
  await (next.always.length || next.never.length ? $.store.set(key, next) : $.store.delete(key))
  await update($, choices, () => next)
}

// A user copy at ~/.claude/skills/smart-compact/SKILL.md overrides the bundled skill.
async function rulesPaths($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const bundled = `${$.plugin.root}/skills/smart-compact/SKILL.md`
  return home ? [`${home.replace(/\\/g, '/')}/.claude/skills/smart-compact/SKILL.md`, bundled] : [bundled]
}

// The "## Always keep" section of the smart-compact skill, or "" when the skill is missing.
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
    '[smart-compact permission check. Do not call tools; reply with one line.]',
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

// The footer label while a grant is active. A footer mode label, not $.ui.status: the engine
// draws a plugin status line among its pinned notices, with a warning sign and the plugin's name.
export function grantMode(held: Grant): string {
  return `${PLUGIN}: ${grantLabel(held)}`
}

async function grantOf($: EngineInterface, agentId?: string): Promise<Grant | null> {
  return (await read($, grants))[agentId ?? MAIN] ?? null
}

async function setGrant($: EngineInterface, next: Grant | null, agentId?: string) {
  const key = agentId ?? MAIN
  await update($, grants, map => {
    const { [key]: _, ...rest } = map
    return next ? { ...rest, [key]: next } : rest
  })
}

async function noteSkill($: EngineInterface, skill: string) {
  await update($, skills, list => (list.includes(skill) ? list : [...list, skill]))
}

type SkillGrant = { outcome: 'granted' | 'renewed' | 'kept'; grant: Grant } | { refused: string }

// What a skill's grant request comes to, whether the plugin read the skill's request line
// itself or Claude passed it on through request_grant. `trustAlways` is false when the
// plugin cannot tell the skill was loaded, so a saved "Always" alone never grants then.
async function grantForSkill(
  $: EngineInterface,
  skill: string,
  context: string,
  how: { canAsk: boolean; trustAlways: boolean; preApproved?: boolean; agentId?: string },
): Promise<SkillGrant> {
  const held = await grantOf($, how.agentId)
  const action = skillGrantAction(held, skill)
  if (action === 'keep') return { outcome: 'kept', grant: held! }
  const saved = await loadChoices($)
  if (!how.preApproved && saved.never.includes(skill)) return { refused: `the user chose "Never" for ${skill} in this project` }
  if (action === 'grant' && !how.preApproved && !(how.trustAlways && saved.always.includes(skill))) {
    if (!how.canAsk) return { refused: `no saved "Always" for ${skill} applies, and the request allowed no dialog` }
    const [always, never] = [`Always for ${skill}`, `Never for ${skill}`]
    let answer: string
    try {
      answer = await $.ui.ask(
        `Skill ${skill} asks to let Claude compact without asking during its work` +
          (context ? `: ${context}` : '') +
          `. Allow it? "Always" and "Never" hold for every load of ${skill} in this project.`,
        { options: ['Allow', always, 'Not now', never], header: 'Compact' },
      )
    } catch {
      return { refused: 'the question was dismissed, or no one could be asked' }
    }
    if (answer === never) await setChoice($, skill, 'never')
    if (answer !== 'Allow' && answer !== always) return { refused: `the user answered: ${answer}` }
    if (answer === always) await setChoice($, skill, 'always')
  }
  const granted: Grant = {
    scope: action === 'renew' ? held!.scope : context || `skill ${skill}`,
    label: action === 'renew' ? held!.label : skill,
    source: `skill:${skill}`,
    turn: await read($, turns),
  }
  await setGrant($, granted, how.agentId)
  if (action === 'grant') $.ui.toast(`Compact permission granted for skill ${skill}`)
  return { outcome: action === 'grant' ? 'granted' : 'renewed', grant: granted }
}

// Why compact and set_compact_brief refuse in a subagent: the plugin can compact only the
// main conversation, and the brief is that conversation's.
export const SUBAGENT_COMPACT =
  'compact runs on the main conversation only, never a subagent\'s. A subagent is compacted by autocompact; ' +
  'put what must survive in files or in your final report.'
export const SUBAGENT_BRIEF =
  "The brief belongs to the main conversation; a subagent's would overwrite it. Put what must survive in files or in your final report."

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
    ? `[smart-compact] Your task brief was saved ${calls} tool calls ago. If the work has moved on since (a step finished, a decision made, a new next step), replace it now with set_compact_brief; otherwise carry on.`
    : '[smart-compact] A compact grant is active but no task brief is saved. Save one now with set_compact_brief so an autocompact keeps the task state.'
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
    (await grantOf($)) ? 'A compact grant is active: refresh the task brief with set_compact_brief once you are oriented.' : '',
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
      `smart-compact: autocompact runs near ${kTokens(breakdown.rawMaxTokens)} tokens. ` +
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
        'Load the smart-compact skill first for the rules. Runs without asking only while a grant is active ' +
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
        'Asks for permission to compact without asking each time until release_grant. Opens a dialog for the user ' +
        'unless a grant already applies, a saved skill choice decides it, `ask` is false, or the caller is a subagent. ' +
        'With `skill`, requests the grant a loaded skill asks for with its SMART-COMPACT:REQUEST_GRANT line.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            ...STRING,
            description: 'The task the grant covers; with `skill`, the text after the skill\'s SMART-COMPACT:REQUEST_GRANT: line.',
          },
          label: { ...STRING, description: 'Three or four words naming that task, for the prompt footer.' },
          skill: {
            ...STRING,
            description: 'The loaded skill whose SMART-COMPACT:REQUEST_GRANT line this passes on, as the Skill tool names it.',
          },
          ask: {
            type: 'boolean',
            description:
              'false: never open a dialog. Only a grant already active or the user\'s saved "Always" for `skill` applies. Default true.',
          },
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
      description: "Show Claude's task brief, the compact grant and saved skill choices in a pane",
      immediate: true,
    })
    // Off the start path: the question waits for the UI, and /autocompact for an idle session.
    $.clock.after(1500, () => offerWindow($).catch(error => $.ui.log(`${PLUGIN}: window offer failed: ${String(error)}`)))
    return next(e)
  })

  // The permission decision for compact. A grant that still stands allows it; a lapsed or
  // stale one is withdrawn, and the call goes to the mode's decider: the auto-mode
  // classifier, which reads the conversation and the call's reason, or the user's dialog.
  on('tool.check', { tool: COMPACT_TOOL }, async ($, e, next) => {
    if (e.agentId) return { decision: 'deny', reason: SUBAGENT_COMPACT }
    const engine = await next(e)
    if (engine.decision === 'deny' || (engine.decision === 'allow' && engine.rule)) return engine
    const held = await grantOf($)
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
    if (e.agentId) return { deny: SUBAGENT_BRIEF }
    const { instructions } = e as unknown as { instructions: string }
    const turn = await read($, turns)
    await update($, brief, () => ({ instructions, turn }))
    await update($, sinceBrief, () => 0)
    await remember($, e.tool_use_id, `Brief saved · ${SHOW}`)
    return { result: 'Brief saved. The next compaction keeps it, including an autocompact mid-turn.' }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__request_grant` }, async ($, e) => {
    const { scope, label, skill, ask } = e as unknown as { scope: string; label?: string; skill?: string; ask?: boolean }
    // A subagent never opens a dialog: whoever spawned it passed on their grant, if they held one.
    const canAsk = ask !== false && !e.agentId
    if (skill) {
      // Where skill.prompt passes over this plugin, Claude passes the skill's request line on here.
      const known = (await read($, skills)).includes(skill) || (await read($, invoked)).includes(skill)
      const got = await grantForSkill($, skill, scope, { canAsk, trustAlways: known, agentId: e.agentId })
      if ('refused' in got) return { deny: `Not granted: ${got.refused}.` }
      await update($, sinceBrief, () => 0)
      await remember($, e.tool_use_id, `Grant active · ${SHOW}`)
      return {
        result:
          got.outcome === 'kept'
            ? `A compact grant is already active (${got.grant.scope}); it covers ${skill}'s work.`
            : `Compact grant active for ${skill}: ${grantLabel(got.grant)}. Keep the task brief current with set_compact_brief.`,
      }
    }
    const current = await grantOf($, e.agentId)
    // A skill's grant may be raised to the user's; the user's own is already the widest.
    if (current?.source === 'user') return { result: 'A compact grant is already active.' }
    if (!canAsk) {
      if (current) return { result: `A compact grant is already active (${current.scope}).` }
      return {
        deny: e.agentId
          ? 'Not granted: a subagent cannot ask the user, and the agent that started it held no grant.'
          : 'Not granted: no grant is active, and the request allowed no dialog.',
      }
    }
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

  on('tool.call', { tool: `mcp__${PLUGIN}__release_grant` }, async ($, e) => {
    await setGrant($, null, e.agentId)
    return { result: 'Compact grant released.' }
  })

  // Skills loaded through the Skill tool are recorded here as well: where an organization
  // manages Claude Code, skill.prompt passes over this plugin and records nothing.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const out = await next(e)
    if (out.deny === undefined) await noteSkill($, e.skill)
    return out
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    await update($, invoked, list => (list.includes(e.command) ? list : [...list, e.command]))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A subagent starts with its own copy of the grant of the loop that spawned it, so it
  // never needs a dialog for work that loop was already allowed to do.
  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    const held = await grantOf($, e.parentAgentId)
    if (out.agentId && held) await setGrant($, held, out.agentId)
    return out
  }).catch(($, e, next) => next(e))

  // While a grant is active or a brief is saved, every briefEvery main-loop tool calls the model
  // gets a reminder, which the user never sees, to bring its brief up to date.
  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    if (briefEvery <= 0 || e.agentId || out.deny !== undefined || e.tool.startsWith(`mcp__${PLUGIN}__`)) return out
    const saved = await read($, brief)
    if (!saved && !(await grantOf($))) return out
    const calls = (await read($, sinceBrief)) + 1
    if (calls < briefEvery) {
      await update($, sinceBrief, () => calls)
      return out
    }
    await update($, sinceBrief, () => 0)
    return { ...out, context: [...(out.context ?? []), briefReminder(calls, saved !== null)] }
  }).catch(($, e, next) => next(e))

  // Reading the grant while drawing redraws the footer whenever it changes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const held = (await read($, grants))[MAIN]
    return held ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, grantMode(held)] } }) : next(e)
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
    // Read fresh: the project root, and so its skill choices, can change during a session.
    const saved = await loadChoices($)
    await update($, choices, () => saved)
    await $.ui.open({ id: BRIEF_COMMAND, title: 'Compact brief', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: BRIEF_COMMAND }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [saved, held, now] = [await read($, brief), (await read($, grants))[MAIN], await read($, turns)]
    const { always, never } = await read($, choices)
    // Forgetting a skill's "Always" also ends the grant that skill holds now.
    const forget = async (skill: string) => {
      await setChoice($, skill, undefined)
      if ((await grantOf($))?.source === `skill:${skill}`) await setGrant($, null)
    }
    const listed = (title: string, list: string[]) => (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        {list.map(skill => (
          <Box key={`skill:${skill}`}>
            <Text>{skill} </Text>
            <Button key={`forget:${skill}`} label="Remove" onPress={() => forget(skill)} />
          </Box>
        ))}
      </Box>
    )
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
        <Text> </Text>
        {always.length ? listed('Skills that grant on every load in this project:', always) : null}
        {never.length ? listed('Skills never granted in this project:', never) : null}
        {always.length || never.length ? null : <Text dimColor>No saved skill choices.</Text>}
        <Text dimColor>Esc to close</Text>
      </Box>
    )
  })

  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    await noteSkill($, e.skill)
    // The plugin reads the request line itself, so it never depends on the model calling request_grant.
    const request = parseGrantRequest(out.text)
    const preApproved = SKILL_PERMISSION.test(out.text)
    if (!request && !preApproved) return out
    const text = request?.text ?? out.text
    const got = await grantForSkill($, e.skill, request?.context ?? '', { canAsk: true, trustAlways: true, preApproved })
    if ('refused' in got || got.outcome === 'kept') return { text }
    return {
      text: `${text.trimEnd()}\n\n[smart-compact] A compact grant covers this skill's work. Keep a task brief with set_compact_brief.`,
    }
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
