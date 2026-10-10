// `turn` is the main-loop turn count when the grant was given or renewed.
export type Grant = { scope: string; source: string; turn: number }

// Claude's own account of the task, merged into compactions it did not request itself.
export type Brief = { instructions: string; turn: number }

export type PendingCompact = { instructions: string; resume?: string }

declare module 'claude-code' {
  interface PluginState {
    'smart-auto-compact': {
      grant: Grant | null
      brief: Brief | null
      pending: PendingCompact | null
      skills: string[]
      turns: number
    }
  }
}
