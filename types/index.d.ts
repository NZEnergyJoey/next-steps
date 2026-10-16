export type StepKind =
  | 'pr'
  | 'sql'
  | 'command'
  | 'file'
  | 'deploy'
  | 'review'
  | 'check'
  | 'action'

export type Step = {
  id: string
  kind: StepKind
  title: string
  detail?: string
  copy?: string
  language?: string
  path?: string
  url?: string
}

export type Repo = { owner: string; name: string; branch: string }

export type StepsStatus = 'idle' | 'working' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'next-steps': {
      steps: Step[]
      done: string[]
      status: StepsStatus
      updatedAt: number
      lastAnswer: string
      repo: Repo | null
    }
  }
}
