import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { On, RenderPropsOf, RenderSurface } from 'claude-code'

/** What the tests share: stand-ins for the model, git and the engine's own calls, and the props a surface hands a site. */

export const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A model that answers with this text. */
export const answered = (text: string) => ({ value: { isAnswered: true as const, text, usage: USAGE } })

/** A model that fails. */
export const failed = (status: number | null = 529) => ({
  value: { isAnswered: false as const, reason: 'api-error' as const, status, error: 'overloaded' as never, usage: USAGE },
})

/** The JSON a model would return for these steps. */
export const reading = (steps: object[], resolved: string[] = []) => JSON.stringify({ steps, resolved })

/** A reply long enough to count as a hand-off, with these lines in it so they can be found there. */
export const reply = (...lines: string[]) => `Here is where things stand.\n\n${lines.join('\n')}\n\n${'Everything else is done and checked. '.repeat(6)}`

export const SQL = 'create table invoices (id uuid primary key, total numeric not null);'
export const MIGRATION_REPLY = reply('Run this in the Supabase SQL editor:', '```sql', SQL, '```', 'Then open a PR for feat/invoices.')

export const MIGRATION_STEPS = [
  { group: 'you', kind: 'sql', title: 'Run the invoices migration', why: 'Adds the table the new page reads from.', copy: SQL, language: 'sql' },
  { group: 'you', kind: 'pr', title: 'Open a PR for feat/invoices' },
  { group: 'claude', kind: 'check', title: 'Run the test suite' },
  { group: 'optional', kind: 'action', title: 'Rename the helper to match the new table' },
]

type Said = ReturnType<typeof answered> | ReturnType<typeof failed>

export type Setup = {
  /** What the model says: one entry per call (the last repeats), or a function that is given the call's number and prompt. */
  model?: Said[] | ((call: number, prompt: string) => Said | Promise<Said>)
  /** What a store already holds. */
  store?: Record<string, unknown>
  /** The surfaces the session draws on. */
  surfaces?: RenderSurface[]
  /** The repository's top level, as git reports it. */
  root?: string
  /** Answers for other git commands, by their arguments joined with spaces. */
  git?: Record<string, string>
}

export type World = {
  /** What the plugin's store holds, to read back; values are JSON as the real store keeps them. */
  store: Map<string, unknown>
  prompts: string[]
  calls: { model: number; toast: string[]; status: Array<string | undefined>; fills: string[]; copies: string[]; opens: number; closes: number }
  clock: ReturnType<typeof mock.clock>
}

/** Stands in for everything beneath the plugin, then starts a session. */
export async function boot($: Engine, on: On, setup: Setup = {}): Promise<World> {
  const world: World = {
    store: new Map(Object.entries(setup.store ?? {})),
    prompts: [],
    calls: { model: 0, toast: [], status: [], fills: [], copies: [], opens: 0, closes: 0 },
    clock: mock.clock(on, { now: 1_700_000_000_000 }),
  }
  // The store is stood in for here rather than by mock.store so that tests can look inside it.
  on('store.get', (_, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_, e) => {
    world.store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    world.store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...world.store.keys()] }))

  const root = setup.root ?? 'C:/Users/j/Code/app'
  const git = setup.git ?? {}
  on('process.run', (_, e) => {
    const line = e.argv.slice(1).join(' ')
    const out =
      line === 'remote get-url origin'
        ? 'git@github.com:acme/app.git'
        : line === 'rev-parse --abbrev-ref HEAD'
          ? 'feat/invoices'
          : line === 'rev-parse --show-toplevel'
            ? root
            : git[line]

    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const script = setup.model ?? [answered(reading([]))]
  on('model.complete', async (_, e) => {
    world.calls.model += 1
    world.prompts.push(e.prompt)
    const said = typeof script === 'function' ? await script(world.calls.model, e.prompt) : (script[Math.min(world.calls.model, script.length) - 1] ?? script[0])

    return said as never
  })
  on('turn.complete', () => ({ text: '' }))

  on('command.register', () => ({ value: { command: 'next-steps' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: setup.surfaces ?? ['terminal'] }))
  on('session.cwd', () => ({ value: root }))
  on('ui.open', () => {
    world.calls.opens += 1

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    world.calls.closes += 1

    return {} as never
  })
  on('ui.toast', (_, e) => {
    world.calls.toast.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.calls.status.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    world.calls.copies.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('prompt.fill', (_, e) => {
    world.calls.fills.push(e.text)

    return { isFilled: true }
  })

  // What the engine draws when the plugin steps aside.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: root, surface: setup.surfaces?.[0] ?? 'terminal', isInteractive: true })

  return world
}

/** A long reply arriving, as the engine reports a finished turn, then the read it starts running to the end. */
export async function finishTurn($: Engine, world: World, text: string, extra: { agentId?: string } = {}) {
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: text, text, ...extra } as never)
  await world.clock.advance(1)
}

export const BAND_PROPS = (over: Partial<RenderPropsOf['AbovePrompt']> = {}): RenderPropsOf['AbovePrompt'] => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
  ...over,
})

export const PANE_PROPS = (over: Partial<RenderPropsOf['Pane']> = {}): RenderPropsOf['Pane'] => ({
  title: 'Next steps',
  isFocused: false,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 14 },
  view: {},
  ...over,
})

export const band = (surface: RenderSurface, over: Partial<RenderPropsOf['AbovePrompt']> = {}) =>
  ({ plugin: 'next-steps', surface, component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS(over) }) as const

export const pane = (surface: RenderSurface, over: Partial<RenderPropsOf['Pane']> = {}) =>
  ({ plugin: 'next-steps', surface, component: 'Pane', requestId: 'next-steps', props: PANE_PROPS(over) }) as const

export const TERMINAL_AND_DESKTOP = ['terminal', 'desktop'] as const
export const ALL_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** The `key`s of the buttons drawn, in order. */
export const buttonKeys = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ key: string | undefined }>> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')

/** The key of the row button for the step with this title. */
export async function rowKey(ui: { find: (q: { type: string; text: RegExp }) => Promise<{ key: string | undefined } | undefined> }, title: string) {
  const row = await ui.find({ type: 'Button', text: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })

  return row?.key ?? ''
}
