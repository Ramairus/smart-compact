import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { alwaysKeep, briefSection, composeInstructions, kTokens, parseVerdict, windowChoices } from '../hooks/register'

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

const COMPACT = { tool: 'mcp__smart-auto-compact__compact', input: { instructions: 'x', reason: 'phase done' } }
const SKILL_GRANT = { skill: 'bundle-audit', text: 'Audit bundles.\ncompact-permission: granted' }
const TURN = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

// Answers the events the plugin passes down, as the engine would, and the judge with `verdict`.
function engine(on: On, verdict?: string) {
  const forks = { count: 0 }
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'no rules file in tests' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
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
  await $.tool.call({ tool: 'mcp__smart-auto-compact__set_compact_brief', instructions: 'Auditing bundle 3 of 7; next: bundle 4.' })
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
