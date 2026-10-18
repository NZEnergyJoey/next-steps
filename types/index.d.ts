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
  /** Where `path` really is, worked out from git when the step was read (see locateFile). */
  file?: FileLink
}

/** A step's file, resolved to the worktree and branch that actually hold it. */
export type FileLink = {
  /** GitHub when that branch is pushed and has the file; otherwise the local file. */
  href: string
  /** Path inside the repository, as shown. */
  label: string
  /** The branch it was found on, when that is not the session's own. */
  branch?: string
  /** What "Copy path" copies: the full local path when the file is in another worktree. */
  copy: string
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
