// The receiving side and the loop guards, event by event.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { marker } from '../hooks/core'

const ID = 'hx-0123456789abcdef'
const HANDOFF = [
  'Handoff from another session: Ship the CSV export',
  '',
  '## Goal',
  'Ship the CSV export',
  '',
  '—',
  'One-way handoff: continue the work here; do not reply to the sender with SendMessage.',
  marker(ID),
].join('\n')
const NOW = Date.UTC(2026, 10, 12, 9, 0)
const TURN = { answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' } as const

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

/** What sits beneath the mod: the engine's answers, from memory. */
function engine(on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const delivered: string[] = []
  on('session.id', () => ({ value: 'session_RECV000001' }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.receive', (_, e) => ({ text: e.text }))
  on('session.send', (_, e) => {
    delivered.push(e.text)

    return { isDelivered: true }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return { clock, delivered }
}

test('a handoff that arrives twice is queued once, and listed in the pane', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  const first = await $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF })
  const again = await $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF })

  expect(first).toEqual({ text: HANDOFF })
  expect(again.consumed).toMatch(/duplicate handoff hx-0123456789abcdef/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Latest handoffs received/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /hx-0123456789abcdef · Ship the CSV export$/ })).toHaveLength(1)
})

test('a handoff delivered twice at once is queued once', async ($, on) => {
  engine(on)
  const both = await Promise.all([
    $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF }),
    $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF }),
  ])

  expect(both.filter(one => one.consumed === undefined)).toHaveLength(1)
})

test('right after a handoff the main model cannot auto-reply; agents and plugins still can', async ($, on) => {
  const { clock, delivered } = engine(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF })

  const reply = await $.session.send({ to: 'sender', text: 'Got it, thanks!', origin: { kind: 'model' } })
  expect(reply.isDelivered).toBe(false)
  expect(reply.reason).toMatch(/to prevent reply loops/)
  expect(
    await $.session.send({ to: 'main', text: 'subtask done', origin: { kind: 'model' }, agentId: 'sub-1' }),
  ).toEqual({ isDelivered: true })
  expect(await $.session.send({ to: 'sender', text: 'ok', origin: { kind: 'plugin', name: 'notes' } })).toEqual({
    isDelivered: true,
  })

  // The turn that read it ends; its time still stands, then runs out.
  await $.turn.complete(TURN)
  expect((await $.session.send({ to: 'sender', text: 'x', origin: { kind: 'model' } })).isDelivered).toBe(false)
  await clock.advance(120_001)
  expect(await $.session.send({ to: 'sender', text: 'All done', origin: { kind: 'model' } })).toEqual({
    isDelivered: true,
  })
  expect(delivered).toEqual(['subtask done', 'ok', 'All done'])
})

test('no model forwards or echoes a handoff, guard or no guard', { options: { replyGuard: false } }, async ($, on) => {
  const { delivered } = engine(on)
  const forwarded = await $.session.send({ to: 'third', text: `FYI\n${HANDOFF}`, origin: { kind: 'model' } })
  const relayed = await $.session.send({ to: 'third', text: HANDOFF, origin: { kind: 'plugin', name: 'relay' } })

  expect(forwarded.isDelivered).toBe(false)
  expect(forwarded.reason).toMatch(/forwarding or echoing it is blocked/)
  expect(relayed.isDelivered).toBe(false)
  expect(delivered).toEqual([])
})

test('with the guard off, replies go through; duplicates are still dropped', { options: { replyGuard: false } }, async ($, on) => {
  engine(on)
  await $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF })
  expect(await $.session.send({ to: 'sender', text: 'Got it', origin: { kind: 'model' } })).toEqual({ isDelivered: true })
  expect((await $.session.receive({ origin: { kind: 'peer' }, text: HANDOFF })).consumed).toBeDefined()
})

test('a delivery for one of this session’s agents is left alone', async ($, on) => {
  engine(on)
  const once = await $.session.receive({ origin: { kind: 'coordinator' }, text: HANDOFF, agentId: 'sub-1' })
  const twice = await $.session.receive({ origin: { kind: 'coordinator' }, text: HANDOFF, agentId: 'sub-1' })

  expect(once).toEqual({ text: HANDOFF })
  expect(twice).toEqual({ text: HANDOFF })
})

test('an answer to our own handoff cannot be answered back automatically', { options: { language: 'en' } }, async ($, on) => {
  const { clock, delivered } = engine(on)

  // Before any handoff, a peer's message raises nothing.
  await $.session.receive({ origin: { kind: 'peer' }, text: 'Hello there' })
  expect(await $.session.send({ to: 'api-worker', text: 'Hi', origin: { kind: 'model' } })).toEqual({ isDelivered: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'manual', text: 'api-worker' })
  for (const [key, text] of Object.entries({ goal: 'Ship it', next: 'Test it', acceptance: 'Tests pass' })) {
    await ui.input({ key: `field-${key}`, text })
  }
  await ui.press({ key: 'review' })
  await ui.press({ key: 'send' })
  expect(delivered).toHaveLength(2)

  // The receiver (without this mod) answers at once; our model may not answer that.
  await clock.advance(5_000)
  await $.session.receive({ origin: { kind: 'peer' }, text: 'Thanks, picking it up!' })
  const back = await $.session.send({ to: 'api-worker', text: 'Great, thanks!', origin: { kind: 'model' } })
  expect(back.isDelivered).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Auto-reply guard on/ })).toBeDefined()
})
