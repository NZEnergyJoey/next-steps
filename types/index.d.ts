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
  /**
   * Where the step must be done, in order, each named in the reply: databases, environments or companies
   * ("HKL", "NZE/PAW", "staging"). Each is ticked off on its own; with all of them ticked the step is done.
   */
  targets?: string[]
  /** The targets ticked off so far. */
  doneTargets?: string[]
  /** The reply wants something sent back once it is done (a query's output, what the reader saw). */
  asksBack?: boolean
  /** For a decision: the answers the reply offers, a few words each. */
  options?: string[]
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

/** The panel's tab: what still needs doing, the suggestions, the steps not mentioned lately, or what is closed. */
export type View = 'todo' | 'optional' | 'earlier' | 'done'

/**
 * The step that was just closed, shown for a moment ("✓ Done · …") while the highlight moves on to the next one.
 * `by` says who closed it: the reader, or a reply that said it was finished.
 */
export type Flash = { id: string; title: string; at: number; by: 'you' | 'reply' }

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
      /** The panel's tab. */
      view: View
      isPaneOpen: boolean
      /** The step just closed, for the moment the highlight moves on; null once that moment has passed. */
      flash: Flash | null
      /** When the reader last had the panel open: steps first seen after it count as new on the bar. */
      seenAt: number
    }
  }
}
