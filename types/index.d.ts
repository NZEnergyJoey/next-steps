export type StepKind =
  | 'pr'
  | 'sql'
  | 'command'
  | 'file'
  | 'deploy'
  | 'review'
  | 'check'
  | 'action'

/**
 * Who a step is for, and how much it matters:
 * - you: only the reader can do it (run SQL, deploy, merge, log in).
 * - decision: Claude needs the reader to choose or approve before it goes on.
 * - claude: Claude can do it when asked; the reader does not have to.
 * - optional: a suggestion that is not needed to finish the task.
 */
export type StepGroup = 'you' | 'decision' | 'claude' | 'optional'

/** `done` and `skipped` are both closed; a skipped step was set aside by the reader. */
export type StepStatus = 'open' | 'done' | 'skipped'

export type Step = {
  id: string
  kind: StepKind
  group: StepGroup
  status: StepStatus
  /** What needs to happen. */
  title: string
  /** Why it needs to happen. */
  why?: string
  /** Text to paste, copied verbatim from the reply (a command, SQL, a snippet). Never cut short: too long means left out. */
  copy?: string
  language?: string
  path?: string
  url?: string
  /** Where `path` really is, worked out from git when the step was read (see locateFile). */
  file?: FileLink
  /** What makes a later reply's step the same step: a hash of the code, else the URL, path or title words. */
  key: string
  firstSeen: number
  lastSeen: number
  /** How many replies in a row, since it was last mentioned, handed over a list without it. */
  missed: number
  closedAt?: number
  /** `you` ticked or skipped it; `reply` a later reply said it was done. */
  closedBy?: 'you' | 'reply'
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

/** Which folded sections of the panel the reader has opened. */
export type Reveal = { optional: boolean; earlier: boolean; closed: boolean }

/** What is kept between sessions for one worktree (see lib/store.ts). */
export type Saved = {
  v: 1
  root: string
  steps: Step[]
  updatedAt: number
  touched: number
}

declare module 'claude-code' {
  interface PluginState {
    'next-steps': {
      steps: Step[]
      status: StepsStatus
      /** Why the last read failed, when status is `error`. */
      error: string | null
      updatedAt: number
      lastAnswer: string
      repo: Repo | null
      /** The worktree this list belongs to (git's top level, else the session's directory). */
      root: string
      /** The step open in the panel: null follows the next step, '' keeps every step folded. */
      selected: string | null
      reveal: Reveal
      isPaneOpen: boolean
    }
  }
}
