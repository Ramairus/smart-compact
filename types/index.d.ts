// `turn` is the main-loop turn count when the grant was given or renewed.
// `label` is the three or four words the prompt footer shows.
export type Grant = { scope: string; label?: string; source: string; turn: number }

// Claude's own account of the task, merged into compactions it did not request itself.
export type Brief = { instructions: string; turn: number }

export type PendingCompact = { instructions: string; resume?: string }

// One project's answers to skills' grant requests that hold for every load.
export type SkillChoices = { always: string[]; never: string[] }

declare module 'claude-code' {
  interface PluginState {
    'smart-compact': {
      grants: Record<string, Grant>
      brief: Brief | null
      pending: PendingCompact | null
      skills: string[]
      turns: number
      sinceBrief: number
      shown: Record<string, string>
      choices: SkillChoices
      invoked: string[]
    }
  }
}
