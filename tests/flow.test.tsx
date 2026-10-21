import { describe, expect, test } from 'claude-code/testing'
import type { CommandRunInput } from 'claude-code'

import { ALL_SURFACES, MIGRATION_REPLY, MIGRATION_STEPS, TERMINAL_AND_DESKTOP, answered, band, boot, failed, finishTurn, pane, reading, reply, stepButton } from './support'

const run = ($: { command: { run: (i: CommandRunInput) => Promise<unknown> } }, args: string) =>
  $.command.run({ command: 'next-steps', args, presentation: { isFullscreen: false, columns: 100 } } as unknown as CommandRunInput)

describe('reading a reply', () => {
  test('a long reply becomes steps, shown in the taskbar, without opening the panel', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS))] })
    await world.clock.advance(1) // the reply lands after the session started, so its steps are new
    await finishTurn($, world, MIGRATION_REPLY)

    expect(world.calls.model).toBe(1)
    expect(world.calls.opens).toBe(0) // the old mod opened a sidebar here; now the taskbar says it
    // Quiet by design: new steps never pop up a toast; the bar marks them "+2 new" until the panel is opened.
    expect(world.calls.toast).toEqual([])

    for (const surface of TERMINAL_AND_DESKTOP) {
      const ui = await $.ui.mount(band(surface))
      const line = await ui.find({ type: 'Text', text: /Next steps/ })
      expect(line?.text).toContain('2 pending')
      expect(line?.text).toContain('Run the invoices migration')
      expect(await ui.find({ type: 'Text', text: /\+2 new/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('short replies, subagent replies and non-answers never touch the list', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS))] })
    await finishTurn($, world, 'Done.')
    await finishTurn($, world, MIGRATION_REPLY, { agentId: 'sub-1' })
    await $.turn.complete({ turnId: 't', reason: 'aborted', answer: MIGRATION_REPLY, text: MIGRATION_REPLY } as never)
    await world.clock.advance(1)
    expect(world.calls.model).toBe(0)
  })

  test('a reply that asks nothing leaves what was outstanding alone', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS)), answered(reading([]))] })
    await finishTurn($, world, MIGRATION_REPLY)
    await finishTurn($, world, reply('All merged and deployed. Nothing for you to do.'))

    const ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain('2 pending')
    await ui.unmount()
  })

  test('the same reply is not read twice, but an explicit refresh reads it again', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS))] })
    await finishTurn($, world, MIGRATION_REPLY)
    await finishTurn($, world, MIGRATION_REPLY)
    expect(world.calls.model).toBe(1)

    await run($, 'refresh')
    await world.clock.advance(1)
    expect(world.calls.model).toBe(2)
  })
})

describe('overlapping reads', () => {
  test('a burst of replies while one is being read costs two reads, and the newest wins', async ($, on) => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const world = await boot($, on, {
      model: async call => {
        if (call === 1) await gate

        return answered(reading([{ group: 'you', kind: 'action', title: `Step from call ${call}` }]))
      },
    })

    await finishTurn($, world, reply('first reply'))
    await finishTurn($, world, reply('second reply'))
    await finishTurn($, world, reply('third reply'))
    release()
    await world.clock.advance(10)

    expect(world.calls.model).toBe(2)
    expect(world.prompts[1]).toContain('third reply')
    expect(world.prompts.join('')).not.toContain('second reply')
  })
})

describe('failures', () => {
  test('a failed read is tried once more, and a second try that works leaves no error', async ($, on) => {
    const world = await boot($, on, { model: [failed(529), answered(reading(MIGRATION_STEPS))] })
    await finishTurn($, world, MIGRATION_REPLY)
    await world.clock.advance(2000)

    expect(world.calls.model).toBe(2)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ type: 'Text', text: /Press r to try again/ })).toBeUndefined()
    expect(await stepButton(ui, /Run the invoices migration/)).toBeDefined()
    await ui.unmount()
  })

  test('two failures show a plain error with a retry, and the list is untouched', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS)), failed(529)] })
    await finishTurn($, world, MIGRATION_REPLY)
    await finishTurn($, world, reply('A second long reply that the model cannot be reached for.'))
    await world.clock.advance(2000)

    for (const surface of ALL_SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: /Couldn't reach the model/ })).toBeDefined()
      expect(await stepButton(ui, /Run the invoices migration/)).toBeDefined()
      await ui.unmount()
    }
  })

  test('a request the provider refuses outright is not retried', async ($, on) => {
    const world = await boot($, on, { model: [failed(400)] })
    await finishTurn($, world, MIGRATION_REPLY)
    await world.clock.advance(5000)
    expect(world.calls.model).toBe(1)
  })

  test('an answer that is not JSON is an error, not an empty list', async ($, on) => {
    const world = await boot($, on, { model: [answered('Sorry, I cannot help with that.')] })
    await finishTurn($, world, MIGRATION_REPLY)
    await world.clock.advance(2000)

    const ui = await $.ui.mount(band('terminal'))
    expect((await ui.find({ type: 'Text', text: /Next steps/ }))?.text).toContain("couldn't read Claude's last reply")
    await ui.unmount()
  })
})

describe('commands', () => {
  test('list prints the open steps in the panel order, done marks one, clear empties', async ($, on) => {
    const world = await boot($, on, { model: [answered(reading(MIGRATION_STEPS))] })
    await finishTurn($, world, MIGRATION_REPLY)

    const listed = JSON.stringify(await run($, 'list'))
    expect(listed).toContain('1. [you] Run the invoices migration')
    expect(listed).toContain('3. [Claude] Run the test suite')
    expect(listed).toContain('4. [optional] Rename the helper')

    expect(JSON.stringify(await run($, 'done 1'))).toContain('Done: Run the invoices migration')
    expect(JSON.stringify(await run($, 'list'))).toContain('1. [you] Open a PR for feat/invoices')
    expect(JSON.stringify(await run($, 'done 9'))).toContain('No step 9')

    expect(JSON.stringify(await run($, 'clear'))).toContain('cleared')
    expect(JSON.stringify(await run($, 'list'))).toContain('No next steps.')
  })

  test('with nothing read yet, refresh says so', async ($, on) => {
    await boot($, on)
    expect(JSON.stringify(await run($, 'refresh'))).toContain('No reply to summarise yet')
  })

  test('opening asks for the keyboard and Esc to close', async ($, on) => {
    const world = await boot($, on)
    await run($, '')
    expect(world.calls.opens).toBe(1)
  })
})
