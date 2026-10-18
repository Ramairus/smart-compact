import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  alwaysKeep,
  briefSection,
  clip,
  composeInstructions,
  grantLabel,
  grantMode,
  kTokens,
  parseVerdict,
  parseGrantRequest,
  shortInput,
  skillGrantAction,
  choicesKey,
  windowChoices,
  withDisplayText,
} from '../hooks/register'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const SKILL = `# Custom compact

## When to compact

- Between phases.

## Always keep

- CLAUDE.md rules.
- Loaded skills.

## Later

- Not this.
`

test('reads only the Always keep section', () => {
  expect(alwaysKeep(SKILL)).toBe('- CLAUDE.md rules.\n- Loaded skills.')
})

test('reads Always keep when it is the last section', () => {
  expect(alwaysKeep('## Always keep\n\n- One.\n')).toBe('- One.')
})

test('missing section gives nothing', () => {
  expect(alwaysKeep('# Nothing here')).toBe('')
})

test('composes rules, skills and the model instructions in order', () => {
  expect(composeInstructions('- A.', ['code-standards'], ' Keep the plan. ')).toBe(
    'Always keep:\n- A.\n\nSkills loaded this session (keep their active rules): code-standards\n\nKeep the plan.',
  )
})

test('composes nothing from nothing', () => {
  expect(composeInstructions('', [], undefined)).toBe('')
})

test('reads a judge verdict', () => {
  expect(parseVerdict('VALID - still the same refactor')).toEqual({ valid: true, why: 'still the same refactor' })
  expect(parseVerdict('**STALE**: user moved on to docs\nmore')).toEqual({ valid: false, why: 'user moved on to docs' })
  expect(parseVerdict('Probably fine').valid).toBe(false)
})

test('dates the brief', () => {
  expect(briefSection({ instructions: 'Phase 2 of 3.', turn: 4 }, 6)).toBe(
    "Claude's task brief (written 2 turns ago; newer conversation wins where they differ):\nPhase 2 of 3.",
  )
  expect(briefSection(null, 6)).toBe('')
})

const COMPACT = { tool: 'mcp__smart-compact__compact', input: { instructions: 'x', reason: 'phase done' } }
const SKILL_GRANT = { skill: 'bundle-audit', text: 'Audit bundles.\ncompact-permission: granted' }
const TURN = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

// Answers the events the plugin passes down, as the engine would, and the judge with `verdict`.
function engine(on: On, verdict?: string, stored: Record<string, unknown> = {}, root = 'C:\\work\\proj') {
  const forks = { count: 0 }
  mock.store(on, stored)
  on('session.root', () => ({ value: root }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'no rules file in tests' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.append', (_$, e) => ({ message: e.message, uuid: 'u' }))
  on('model.fork', () => {
    forks.count++
    return {
      value:
        verdict === undefined
          ? { isAnswered: false as const, reason: 'nothing-to-fork' as const }
          : { isAnswered: true as const, text: verdict, usage: USAGE },
    }
  })
  return forks
}

test('without a grant, compact goes to the mode decider', async ($, on) => {
  engine(on)
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
})

test('a skill grant the judge still holds allows compact', async ($, on) => {
  const forks = engine(on, 'VALID - same task')
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
  expect(forks.count).toBe(2)
})

test('a grant the judge finds stale is withdrawn', async ($, on) => {
  const forks = engine(on, '**STALE**: the user switched to a new task')
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
  expect(forks.count).toBe(1)
})

test('a grant past its turn limit lapses without asking the judge', { options: { grantMaxTurns: 1 } }, async ($, on) => {
  const forks = engine(on, 'VALID')
  await $.skill.prompt(SKILL_GRANT)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
  expect(forks.count).toBe(0)
})

test('reloading the skill renews its grant', { options: { grantMaxTurns: 1 } }, async ($, on) => {
  engine(on, 'VALID')
  await $.skill.prompt(SKILL_GRANT)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
})

test('a judge that cannot answer does not allow', async ($, on) => {
  engine(on)
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
})

test('trust mode skips the judge', { options: { grantCheck: 'trust' } }, async ($, on) => {
  const forks = engine(on)
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
  expect(forks.count).toBe(0)
})

test('autocompact carries the saved brief', async ($, on) => {
  engine(on)
  let seen = ''
  on('session.compact', (_$, e) => ((seen = e.instructions ?? ''), { skip: 'test' }))
  await $.tool.call({ tool: 'mcp__smart-compact__set_compact_brief', instructions: 'Auditing bundle 3 of 7; next: bundle 4.' })
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'Audit the bundles.', toolUses: [] }] })
  expect(seen).toContain("Claude's task brief (written this turn")
  expect(seen).toContain('Auditing bundle 3 of 7')
})

test('offers up to two windows below the current one', () => {
  expect(windowChoices(1_000_000)).toEqual([200_000, 150_000])
  expect(windowChoices(200_000)).toEqual([150_000, 100_000])
  expect(windowChoices(120_000)).toEqual([100_000])
  expect(windowChoices(100_000)).toEqual([])
  expect(kTokens(150_000)).toBe('150k')
})

test('a grant label is at most four words', () => {
  expect(grantLabel({ scope: 'x', label: 'gradle-port bundles', source: 'user', turn: 0 })).toBe('gradle-port bundles')
  expect(grantLabel({ scope: 'Execute the whole gradle-port bundle set', source: 'user', turn: 0 })).toBe('Execute the whole gradle-port…')
})

test('tool rows clip long inputs to their first line', () => {
  expect(clip('Short.')).toBe('Short.')
  expect(clip('Line one.\nLine two.')).toBe('Line one.…')
  expect(clip('a'.repeat(60))).toBe(`${'a'.repeat(48)}…`)
  expect(shortInput('mcp__smart-compact__set_compact_brief', { instructions: 'Long brief.' })).toEqual({})
  expect(shortInput('mcp__smart-compact__request_grant', { scope: 'One.', label: 'bundles' })).toEqual({ label: 'bundles' })
  expect(shortInput('mcp__smart-compact__compact', { instructions: 'x', reason: 'Phase done.\nMore.' })).toEqual({
    reason: 'Phase done.…',
  })
})

test('display text replaces the first text block and drops the rest', () => {
  expect(withDisplayText('saved', 'full')).toBe('full')
  expect(withDisplayText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'full')).toEqual([{ type: 'text', text: 'full' }])
  expect(withDisplayText({ content: [{ type: 'text', text: 'a' }], isError: false }, 'full')).toEqual({
    content: [{ type: 'text', text: 'full' }],
    isError: false,
  })
  expect(withDisplayText({ other: 1 }, 'full')).toBeUndefined()
})

const READ = { tool: 'Read', file_path: 'a.ts' } as const

test('reminds Claude to refresh a stale brief', { options: { briefReminderCalls: 2 } }, async ($, on) => {
  engine(on)
  on('tool.call', (_$, e) => (e.tool === 'Read' ? { result: 'file' } : { deny: 'unexpected' }))
  expect((await $.tool.call(READ)).context).toBeUndefined()
  await $.tool.call({ tool: 'mcp__smart-compact__set_compact_brief', instructions: 'Step 1 of 3.' })
  expect((await $.tool.call(READ)).context).toBeUndefined()
  expect((await $.tool.call(READ)).context?.[0]).toContain('saved 2 tool calls ago')
  expect((await $.tool.call(READ)).context).toBeUndefined()
})

const PANE = {
  component: 'Pane',
  requestId: 'compact-brief',
  props: {
    title: 'Compact brief',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the brief pane shows the saved brief on every surface', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'mcp__smart-compact__set_compact_brief', instructions: 'Bundle 4 of 16.' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smart-compact', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Bundle 4 of 16/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No compact grant/ })).toBeDefined()
    await ui.unmount()
  }
})

const ASKING_SKILL = {
  skill: 'bundle-audit',
  text: 'Audit bundles.\nSMART-COMPACT:REQUEST_GRANT: auditing every bundle in one pass\nThen report.',
}
const USER_GRANT = { tool: 'mcp__smart-compact__request_grant', scope: 'The whole session.', label: 'session' } as const
const RELEASE = { tool: 'mcp__smart-compact__release_grant' } as const

// Answers every dialog with `answer` and records the options each offered.
function answerAsk(on: On, answer: string) {
  const offered: string[][] = []
  on('tool.call', (_$, e) => {
    if (e.tool !== 'AskUserQuestion') return { deny: 'unexpected' }
    offered.push(e.questions[0]!.options.map(o => o.label))
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: answer } } }
  })
  return offered
}

test('reads the grant request line and takes it out of the skill text', () => {
  expect(parseGrantRequest('A.\nSMART-COMPACT:REQUEST_GRANT: bundle audit  \nB.')).toEqual({
    context: 'bundle audit',
    text: 'A.\nB.',
  })
  expect(parseGrantRequest('SMART-COMPACT:REQUEST_GRANT')).toEqual({ context: '', text: '' })
  expect(parseGrantRequest('Mentions SMART-COMPACT:REQUEST_GRANT mid-line.')).toBeUndefined()
  expect(parseGrantRequest('A.\r\nSMART-COMPACT:REQUEST_GRANT: x\r\nB.')).toEqual({ context: 'x', text: 'A.\r\nB.' })
})

test('a request line in a code block is an example, not a request', () => {
  const example = 'Template:\n\n  ```markdown\n  SMART-COMPACT:REQUEST_GRANT: <the work>\n  ```\n'
  expect(parseGrantRequest(example)).toBeUndefined()
  expect(parseGrantRequest(`${example}SMART-COMPACT:REQUEST_GRANT: real\nEnd.`)).toEqual({ context: 'real', text: `${example}End.` })
})

test('a skill never replaces a session grant', () => {
  const user = { scope: 's', source: 'user', turn: 0 }
  expect(skillGrantAction(null, 'a')).toBe('grant')
  expect(skillGrantAction(user, 'a')).toBe('keep')
  expect(skillGrantAction({ scope: 's', source: 'skill:a', turn: 0 }, 'a')).toBe('renew')
  expect(skillGrantAction({ scope: 's', source: 'skill:b', turn: 0 }, 'a')).toBe('grant')
})

test('a project key ignores slash direction, trailing slashes and Windows case', () => {
  expect(choicesKey('C:\\Work\\Proj\\')).toBe('skills:c:/work/proj')
  expect(choicesKey('/home/Me/proj/')).toBe('skills:/home/Me/proj')
})

test('the request line asks once, and Always grants on every later load', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Always for bundle-audit')
  const loaded = await $.skill.prompt(ASKING_SKILL)
  expect(offered).toEqual([['Allow', 'Always for bundle-audit', 'Not now', 'Never for bundle-audit']])
  expect(loaded.text).not.toContain('REQUEST_GRANT')
  expect(loaded.text).toContain('A compact grant covers')
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
  await $.tool.call(RELEASE)
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(1)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
})

test('allowing once asks again on the next load', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Allow')
  await $.skill.prompt(ASKING_SKILL)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
  await $.tool.call(RELEASE)
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(2)
})

test('declining leaves no grant', async ($, on) => {
  engine(on)
  answerAsk(on, 'Not now')
  const loaded = await $.skill.prompt(ASKING_SKILL)
  expect(loaded.text).toBe('Audit bundles.\nThen report.')
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
})

test('a session grant is kept, without asking, when a skill requests one', async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Allow')
  await $.tool.call(USER_GRANT)
  await $.skill.prompt(ASKING_SKILL)
  await $.skill.prompt(SKILL_GRANT)
  expect(offered.length).toBe(1)
  const ui = await $.ui.mount({ plugin: 'smart-compact', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /The whole session/ })).toBeDefined()
  await ui.unmount()
})

test('a session grant replaces a skill grant', async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Allow')
  await $.skill.prompt(SKILL_GRANT)
  expect((await $.tool.call(USER_GRANT)).result).toContain('Compact grant active: session')
  expect(offered.length).toBe(1)
})

test('skill choices are kept per project', async ($, on) => {
  engine(on, undefined, { 'skills:c:/work/other': { always: ['bundle-audit'], never: [] } })
  const offered = answerAsk(on, 'Not now')
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(1)
})

test('a saved Always for this project grants without asking', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on, undefined, { 'skills:c:/work/proj': { always: ['bundle-audit'], never: [] } })
  const offered = answerAsk(on, 'Not now')
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(0)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
})

test('removing an Always in the pane ends it and its grant', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Always for bundle-audit')
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.skill.prompt(ASKING_SKILL)
    const ui = await $.ui.mount({ plugin: 'smart-compact', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /bundle-audit/ })).toBeDefined()
    await ui.press({ key: 'forget:bundle-audit' })
    expect(await ui.find({ type: 'Text', text: /No saved skill choices/ })).toBeDefined()
    await ui.unmount()
    expect((await $.tool.check(COMPACT)).decision).toBe('ask')
  }
  expect(offered.length).toBe(2)
})

test('Never refuses on every later load without asking', async ($, on) => {
  engine(on)
  const offered = answerAsk(on, 'Never for bundle-audit')
  const loaded = await $.skill.prompt(ASKING_SKILL)
  expect(loaded.text).not.toContain('REQUEST_GRANT')
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(1)
  expect((await $.tool.check(COMPACT)).decision).toBe('ask')
})

test('removing a Never in the pane asks again on the next load', async ($, on) => {
  engine(on, undefined, { 'skills:c:/work/proj': { always: [], never: ['bundle-audit'] } })
  const offered = answerAsk(on, 'Not now')
  await $.command.run({ command: 'compact-brief' })
  const ui = await $.ui.mount({ plugin: 'smart-compact', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /never granted/ })).toBeDefined()
  await ui.press({ key: 'forget:bundle-audit' })
  await ui.unmount()
  await $.skill.prompt(ASKING_SKILL)
  expect(offered.length).toBe(1)
})

test('the footer names the grant in a few words', () => {
  expect(grantMode({ scope: 'WV planning for the whole release', label: 'WV planning', source: 'user', turn: 0 })).toBe(
    'smart-compact: WV planning',
  )
})

test('an active grant shows in the footer modes', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  answerAsk(on, 'Allow')
  // Stands in for the engine's footer: draws the modes it is handed.
  let drawn: readonly string[] = []
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    drawn = e.props.modes
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, drawn.join(' & '))
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.tool.call(USER_GRANT)
    const ui = await $.ui.mount({ plugin: 'smart-compact', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect(drawn).toEqual(['focus', 'smart-compact: session'])
    await ui.unmount()
    await $.tool.call(RELEASE)
  }
})

const REQUEST = { tool: 'mcp__smart-compact__request_grant', scope: 'a bundle set, bundle by bundle', label: 'bundles' } as const
const SKILL_REQUEST = { ...REQUEST, skill: 'bundle-workflow' } as const
const ALWAYS_BUNDLES = { 'skills:c:/work/proj': { always: ['bundle-workflow'], never: [] } }

// Answers the Skill tool, and every dialog with `answer`, counting the dialogs.
function tools(on: On, answer = 'Allow') {
  const asked = { count: 0 }
  on('tool.call', (_$, e) => {
    if (e.tool === 'Skill') return { result: 'Launching skill' } as never
    if (e.tool !== 'AskUserQuestion') return { deny: 'unexpected' }
    asked.count++
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: answer } } }
  })
  return asked
}

test('request_grant passes on a loaded skill\'s request, and a saved Always grants without a dialog', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on, undefined, ALWAYS_BUNDLES)
  const asked = tools(on)
  await $.tool.call({ tool: 'Skill', skill: 'bundle-workflow' })
  expect((await $.tool.call({ ...SKILL_REQUEST, ask: false })).result).toContain('Compact grant active for bundle-workflow')
  expect(asked.count).toBe(0)
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
})

test('a skill typed as a slash command counts as loaded', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on, undefined, ALWAYS_BUNDLES)
  on('command.run', () => ({ text: '' }))
  tools(on)
  await $.command.run({ command: 'bundle-workflow' })
  expect((await $.tool.call({ ...SKILL_REQUEST, ask: false })).result).toContain('Compact grant active')
})

test('a saved Always does not apply to a skill that was never loaded', async ($, on) => {
  engine(on, undefined, ALWAYS_BUNDLES)
  const asked = tools(on, 'Not now')
  expect((await $.tool.call({ ...SKILL_REQUEST, ask: false })).deny).toContain('Not granted')
  expect(asked.count).toBe(0)
  await $.tool.call(SKILL_REQUEST)
  expect(asked.count).toBe(1)
})

test('a skill request respects a saved Never without a dialog', async ($, on) => {
  engine(on, undefined, { 'skills:c:/work/proj': { always: [], never: ['bundle-workflow'] } })
  const asked = tools(on)
  expect((await $.tool.call(SKILL_REQUEST)).deny).toContain('Never')
  expect(asked.count).toBe(0)
})

test('ask false never opens a dialog', async ($, on) => {
  engine(on)
  const asked = tools(on)
  expect((await $.tool.call({ ...REQUEST, ask: false })).deny).toContain('allowed no dialog')
  expect(asked.count).toBe(0)
})

test('a subagent inherits the grant of the agent that spawned it, without a dialog', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  const asked = tools(on)
  await $.tool.call(REQUEST)
  await $.agent.spawn({ prompt: 'Run bundle 3.' })
  expect((await $.tool.call({ ...REQUEST, agentId: 'sub1' })).result).toContain('already active')
  expect((await $.tool.call({ ...SKILL_REQUEST, agentId: 'sub1' })).result).toContain('already active')
  expect(asked.count).toBe(1)
  await $.tool.call({ ...RELEASE, agentId: 'sub1' })
  expect((await $.tool.check(COMPACT)).decision).toBe('allow')
})

test('a subagent with nothing to inherit is refused without a dialog', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'sub1' }))
  const asked = tools(on)
  await $.agent.spawn({ prompt: 'Run bundle 3.' })
  expect((await $.tool.call({ ...REQUEST, agentId: 'sub1' })).deny).toContain('subagent cannot ask')
  expect(asked.count).toBe(0)
})

test('a subagent cannot compact the main conversation or overwrite its brief', { options: { grantCheck: 'trust' } }, async ($, on) => {
  engine(on)
  tools(on)
  await $.tool.call(REQUEST)
  expect((await $.tool.check({ ...COMPACT, agentId: 'sub1' })).decision).toBe('deny')
  expect((await $.tool.call({ tool: 'mcp__smart-compact__set_compact_brief', instructions: 'x', agentId: 'sub1' })).deny).toBeDefined()
})
