// The pane as a person uses it: pick a session, fill the brief, review the
// exact text, send it once.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { composeBody, fingerprint, handoffId } from '../hooks/core'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'session-handoff',
  component: 'Pane',
  requestId: 'session-handoff',
  props: {
    title: 'Session handoff',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 10, 12, 9, 0)
const LISTING = {
  listing: 'api-worker [a1b2c3] (idle)',
  sections: [
    { kind: 'local sessions', total: 1, rows: [{ name: 'api-worker', ref: 'a1b2c3', status: 'idle' }] },
  ],
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Put together at run time, so no file holds a credential-shaped string.
const SECRET_VALUE = ['correct', 'horse', 'battery'].join('-')

const BRIEF = {
  goal: 'Ship the CSV export for the reports page',
  done: 'Added the export button\nWrote the serializer',
  decisions: `Use the staging database (DB_PASSWORD=${SECRET_VALUE})`,
  files: 'src/reports/export.ts',
  next: 'Write the integration test for 10k rows',
  acceptance: 'npm test passes and a 10k-row export downloads in under 3 s',
}
const MINIMAL = { goal: 'Ship it', next: 'Test it', acceptance: 'Tests pass' }

type Sent = { to: string; text: string }
type Delivery = { isDelivered: true } | { isDelivered: false; reason: string }
type Typing = { input: (target: { key: string; text: string }) => Promise<unknown> }

/**
 * A store the test holds the keys to: `arm()` makes the next reads of the
 * sent ledger wait at a gate until `release()`, so a test can act while a
 * press is half way through.
 */
function gatedStore(on: On) {
  const map = new Map<string, unknown>()
  let isArmed = false
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  let onReach = () => {}
  const reached = new Promise<void>(resolve => (onReach = resolve))
  let waits = 0
  on('store.get', async (_, e) => {
    if (isArmed && e.key === 'sent') {
      waits += 1
      onReach()
      await gate
    }

    return { value: map.get(e.key) }
  })
  on('store.set', (_, e) => {
    map.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...map.keys()] }))

  return { map, arm: () => (isArmed = true), reached, release: () => release(), waits: () => waits }
}

/** What sits beneath the mod: the engine's answers, from memory. */
function engine(
  on: On,
  options: { deliver?: (sent: Sent) => Delivery; store?: Record<string, unknown> | false } = {},
) {
  const sent: Sent[] = []
  if (options.store !== false) mock.store(on, options.store)
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'session_SELF000001' }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  on('session.send', (_, e) => {
    const one = { to: e.to, text: e.text }
    sent.push(one)

    return options.deliver?.(one) ?? { isDelivered: true }
  })

  return { sent, clock }
}

async function type(ui: Typing, fields: Readonly<Record<string, string>>): Promise<void> {
  for (const [key, text] of Object.entries(fields)) await ui.input({ key: `field-${key}`, text })
}

for (const surface of SURFACES) {
  test(`pick a session, review the exact text, send it once (${surface})`, { options: { language: 'en' } }, async ($, on) => {
    const { sent } = engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: 'pick-0' }))?.text).toContain('api-worker [a1b2c3]')
    await ui.press({ key: 'pick-0' })
    expect(await ui.find({ type: 'Text', text: /Recipient: api-worker \[a1b2c3\]/ })).toBeDefined()

    await type(ui, BRIEF)
    await ui.press({ key: 'review' })

    const text = String((await ui.find({ type: 'Code' }))?.props.source ?? '')
    expect(text).toStartWith('Handoff from another session: Ship the CSV export for the reports page')
    for (const heading of ['Goal', 'Done', 'Decisions', 'File paths', 'Next step', 'Acceptance criterion']) {
      expect(text).toContain(`## ${heading}\n`)
    }
    expect(text).not.toContain(SECRET_VALUE)
    expect(text).toContain('DB_PASSWORD=[REDACTED:secret-value]')
    expect(await ui.find({ type: 'Text', text: /Possible secrets redacted before sending: secret-value ×1/ })).toBeDefined()
    expect(sent).toHaveLength(0)

    await ui.press({ key: 'send' })
    expect(sent).toEqual([{ to: 'api-worker [a1b2c3]', text }])
    expect(await ui.find({ type: 'Text', text: /Handoff hx-[0-9a-f]{16} sent to api-worker \[a1b2c3\]/ })).toBeDefined()

    // The same brief to the same session again: the review says so, and offers no send.
    await ui.press({ key: 'review' })
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /This same handoff was sent to api-worker \[a1b2c3\]/ })).toBeDefined()
    expect(sent).toHaveLength(1)
    await ui.unmount()
  })
}

test('the same brief may go to another session', { options: { language: 'en' } }, async ($, on) => {
  const { sent } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await type(ui, MINIMAL)
  for (const name of ['api-worker', 'web-worker']) {
    await ui.input({ key: 'manual', text: name })
    await ui.press({ key: 'review' })
    await ui.press({ key: 'send' })
  }
  expect(sent.map(one => one.to)).toEqual(['api-worker', 'web-worker'])
})

test('a send that is not delivered can be tried again', { options: { language: 'en' } }, async ($, on) => {
  let attempts = 0
  const { sent } = engine(on, {
    deliver: () => (++attempts === 1 ? { isDelivered: false, reason: 'nobody by that name' } : { isDelivered: true }),
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })

  await ui.press({ key: 'send' })
  expect(await ui.find({ type: 'Text', text: /Not sent: nobody by that name/ })).toBeDefined()
  await ui.press({ key: 'send' })
  expect(sent).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /sent to api-worker/ })).toBeDefined()
})

test('two presses at the same moment send one message', { options: { language: 'en' } }, async ($, on) => {
  const { sent } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })

  await Promise.allSettled([ui.press({ key: 'send' }), ui.press({ key: 'send' })])
  expect(sent).toHaveLength(1)
})

test('a second press while the first is on its way sends nothing more', { options: { language: 'en' } }, async ($, on) => {
  const store = gatedStore(on)
  const { sent, clock } = engine(on, { store: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })

  store.arm()
  const first = ui.press({ key: 'send' })
  await store.reached // the first press is reading the ledger, nothing booked yet
  const second = ui.press({ key: 'send' })
  await clock.settle() // the second press runs as far as it can
  const waiting = store.waits()
  store.release()
  await Promise.allSettled([first, second])

  expect(waiting).toBe(1) // only the first press is at the ledger: the second stopped at once
  expect(sent).toHaveLength(1)
})

test('a handoff another session sent after the review is not sent again', { options: { language: 'en' } }, async ($, on) => {
  const store = gatedStore(on)
  const { sent } = engine(on, { store: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })
  expect(await ui.find({ key: 'send' })).toBeDefined()

  // Meanwhile another session on this machine sends the very same handoff.
  const fp = await fingerprint('name:api-worker', composeBody({ ...MINIMAL, done: '', decisions: '', files: '' }, 'en').body)
  store.map.set('sent', {
    [fp]: { id: handoffId(fp), to: 'name:api-worker', label: 'api-worker', at: NOW - 1000, status: 'delivered' },
  })
  await ui.press({ key: 'send' })

  expect(sent).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /This same handoff was sent to api-worker/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
})

test('what goes is what was reviewed: a draft changed behind the review is not sent', { options: { language: 'en' } }, async ($, on) => {
  let isTampered = false
  // Stands for a write the pane never makes (its edits drop the review):
  // the draft as read after the review is no longer the one reviewed.
  on('state.get', { key: 'draft' }, (_, e, next) =>
    isTampered
      ? { value: { value: { shape: 'draft-1', value: { ...MINIMAL, goal: 'Something else', done: '', decisions: '', files: '' } }, version: 1000 } }
      : next(e),
  )
  const { sent } = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })

  isTampered = true
  await ui.press({ key: 'send' })

  expect(sent).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /changed after the review; review the message again/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
})

test('no more than the hourly limit leaves this machine', { options: { language: 'en', maxHandoffsPerHour: 2 } }, async ($, on) => {
  const booked = (id: string) => ({ id, to: 'name:other', label: 'other', at: NOW - 60_000, status: 'delivered' })
  const { sent } = engine(on, { store: { sent: { fp1: booked('hx-1'), fp2: booked('hx-2') } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  await type(ui, MINIMAL)
  await ui.press({ key: 'review' })
  await ui.press({ key: 'send' })

  expect(sent).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /limit \(2\) of handoffs per hour/ })).toBeDefined()
})

test('a review needs a recipient, the required parts, and another session', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'review' })
  expect(await ui.find({ type: 'Text', text: /Choose the receiving session first/ })).toBeDefined()

  await ui.input({ key: 'manual', text: 'api-worker' })
  await ui.press({ key: 'review' })
  expect(
    await ui.find({ type: 'Text', text: /Fill the required fields: Goal, Next step, Acceptance criterion/ }),
  ).toBeDefined()

  await type(ui, MINIMAL)
  await ui.input({ key: 'manual', text: 'session_SELF000001' })
  await ui.press({ key: 'review' })
  expect(await ui.find({ type: 'Text', text: /cannot hand off to itself/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
})

test('drafting asks a fork for the brief and takes the files from edit calls', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } }],
      },
    ],
  }))
  const asked: string[] = []
  on('model.fork', (_, e) => {
    asked.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: '{"goal":"G","done":"D","decisions":"","files":"","next":"N","acceptance":"A"}',
        usage: USAGE,
      },
    }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'field-done', text: 'typed by the person' })
  await ui.press({ key: 'draft' })

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('ONLY one JSON object')
  expect((await ui.find({ key: 'field-goal' }))?.props.value).toBe('G')
  expect((await ui.find({ key: 'field-done' }))?.props.value).toBe('typed by the person')
  expect((await ui.find({ key: 'field-files' }))?.props.value).toBe('src/a.ts')
  expect(
    await ui.find({ type: 'Text', text: /Filled the empty fields: Goal, File paths, Next step, Acceptance criterion/ }),
  ).toBeDefined()
})

test('with nothing to fork yet, drafting says so', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'draft' })
  expect(await ui.find({ type: 'Text', text: /No conversation to draft from yet/ })).toBeDefined()
})

test('/handoff opens the pane and lists the sessions', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  const opened: unknown[] = []
  on('command.register', () => ({ value: { command: 'handoff' } }))
  on('ui.open', (_, e) => {
    opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({
    command: 'handoff',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('Session handoff pane opened')
  expect(opened).toEqual([expect.objectContaining({ id: 'session-handoff', focus: true })])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'pick-0' }))?.text).toContain('api-worker [a1b2c3]')
})

test('the pane speaks Arabic by default', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /الجلسة المستقبلة/ })).toBeDefined()
  expect((await ui.find({ key: 'review' }))?.text).toContain('مراجعة الرسالة')
})

test('a drawing the mod leaves goes to the engine', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...PANE, requestId: 'other', surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
})
