// The pure rules: what a handoff holds, what is redacted, what is a
// duplicate, when a message may leave.

import { expect, test } from 'claude-code/testing'

import {
  EMPTY_DRAFT,
  LEDGER_MAX_AGE_MS,
  MAX_MESSAGE_CHARS,
  MAX_TURN_GUARD_MS,
  candidatesFrom,
  composeBody,
  composeMessage,
  editedFiles,
  extractHandoffId,
  fillEmpty,
  fingerprint,
  formatCount,
  handoffId,
  isGuardActive,
  isSentEntry,
  judgeSend,
  marker,
  parseDraftReply,
  readLedger,
  recipientFromInput,
  redact,
  sendAddress,
} from '../hooks/core'
import type { HandoffDraft, HandoffGuard } from '../types'

// Fixtures are put together at run time, so no file of the mod holds a string
// a secret scanner or a push protection would take for a real credential.
const join = (...parts: string[]) => parts.join('')
const SECRETS: readonly { name: string; input: string; secret: string; kind: string }[] = [
  {
    name: 'Anthropic key',
    input: join('sk-', 'ant-', 'api03-', 'Q'.repeat(32)),
    secret: 'Q'.repeat(32),
    kind: 'anthropic-key',
  },
  { name: 'GitHub token', input: join('gh', 'p_', 'A1b2C3d4'.repeat(5)), secret: 'A1b2C3d4'.repeat(5), kind: 'github-token' },
  { name: 'AWS key id', input: join('AK', 'IA', 'QWERTYUIOPASDFGH'), secret: 'QWERTYUIOPASDFGH', kind: 'aws-access-key' },
  { name: 'Slack token', input: join('xo', 'xb-', '123456789012-', 'abcdefghijkl'), secret: 'abcdefghijkl', kind: 'slack-token' },
  {
    name: 'JWT',
    input: join('ey', 'J', 'h'.repeat(16), '.', 'p'.repeat(16), '.', 's'.repeat(16)),
    secret: 's'.repeat(16),
    kind: 'jwt',
  },
  {
    name: 'private key',
    input: join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', 'b3BlbnNzaC1rZXktdjEAAAAA\n', '-----END ', 'OPENSSH PRIVATE KEY-----'),
    secret: 'b3BlbnNzaC1rZXktdjEAAAAA',
    kind: 'private-key',
  },
  {
    name: 'credentials in a URL',
    input: join('postgres://admin:', 'n0t-a-real-pass', '@db.internal:5432/app'),
    secret: 'n0t-a-real-pass',
    kind: 'url-credentials',
  },
  { name: 'NAME=value', input: join('DB_PASSWORD=', 'correct-horse-battery'), secret: 'correct-horse-battery', kind: 'secret-value' },
  {
    name: 'JSON field',
    input: join('{"apiKey": "', 'k3y-v4lue-0123', '"}'),
    secret: 'k3y-v4lue-0123',
    kind: 'secret-value',
  },
  {
    name: 'Authorization header',
    input: join('Authorization: Bearer ', 'abcdefghijklmnopqrstuvwx'),
    secret: 'abcdefghijklmnopqrstuvwx',
    kind: 'auth-header',
  },
]

const DRAFT: HandoffDraft = {
  goal: 'Ship the CSV export for the reports page',
  done: '- Added the export button\n* Wrote the serializer',
  decisions: 'Stream rows instead of building the file in memory (large reports)',
  files: 'src/reports/export.ts\nsrc/reports/Export.tsx\nsrc/reports/export.ts',
  next: 'Write the integration test for 10k rows',
  acceptance: 'npm test passes and a 10k-row export downloads in under 3 s',
}

test('every known secret format is redacted and named by its kind', () => {
  for (const one of SECRETS) {
    const { text, redactions } = redact(`before ${one.input} after`)
    expect(text, one.name).not.toContain(one.secret)
    expect(text, one.name).toContain(`[REDACTED:${one.kind}]`)
    expect(redactions, one.name).toContainEqual({ kind: one.kind, count: 1 })
    expect(text, one.name).toStartWith('before ')
  }
})

test('what only looks like a secret is kept as written', () => {
  const plain = [
    'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'src/auth/token-refresh.ts and config/secrets.example.yaml',
    'max_tokens=200000',
    'API_KEY=$API_KEY',
    'password: <set in the vault>',
    'Rotate the API key next week; the token is short-lived.',
  ]
  for (const line of plain) expect(redact(line), line).toEqual({ text: line, redactions: [] })
})

test('a handoff holds the six parts in order, its summary first and its marker last', async () => {
  const body = composeBody(DRAFT, 'en')
  expect(body.missing).toEqual([])
  const id = handoffId(await fingerprint('name:api-worker', body.body))
  const text = composeMessage(body, id, 'en')

  const at = ['## Goal', '## Done', '## Decisions', '## File paths', '## Next step', '## Acceptance criterion'].map(
    heading => text.indexOf(heading),
  )
  expect(at.every(index => index > 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(text.split('\n')[0]).toBe('Handoff from another session: Ship the CSV export for the reports page')
  expect(text).toContain('do not reply to the sender with SendMessage')
  expect(text).toEndWith(marker(id))
  expect(extractHandoffId(text)).toBe(id)
  expect(id).toMatch(/^hx-[0-9a-f]{16}$/)
  // One item per line, bullets made uniform, a path listed twice listed once.
  expect(body.values.done).toBe('- Added the export button\n- Wrote the serializer')
  expect(body.values.files).toBe('- src/reports/export.ts\n- src/reports/Export.tsx')
})

test('in Arabic the headings carry their English names too', () => {
  const body = composeBody(DRAFT, 'ar')
  expect(body.body).toContain('## الهدف (Goal)')
  expect(body.body).toContain('## معيار القبول (Acceptance criterion)')
  const text = composeMessage(body, 'hx-0123456789abcdef', 'ar')
  expect(text).toStartWith('تسليم مهمة من جلسة أخرى: Ship the CSV export')
})

test('goal, next step and acceptance criterion are required; empty parts say so', () => {
  const body = composeBody({ ...EMPTY_DRAFT, done: 'something' }, 'en')
  expect(body.missing).toEqual(['goal', 'next', 'acceptance'])
  expect(composeBody({ ...DRAFT, decisions: '' }, 'en').body).toContain('## Decisions\n(none)')
})

test('a pasted conversation cannot ride along: each field is capped, and the message', () => {
  const transcript = Array.from({ length: 5000 }, (_, index) => `User: line ${index}`).join('\n')
  const huge: HandoffDraft = {
    goal: transcript,
    done: transcript,
    decisions: transcript,
    files: transcript,
    next: transcript,
    acceptance: transcript,
  }
  const body = composeBody(huge, 'ar')
  expect(body.truncated).toEqual(['goal', 'done', 'decisions', 'files', 'next', 'acceptance'])
  const text = composeMessage(body, 'hx-0123456789abcdef', 'ar')
  expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
  expect(text.length).toBeLessThan(transcript.length / 10)
  expect(text).toEndWith(marker('hx-0123456789abcdef'))
})

test('a field cannot forge a handoff id, steer a terminal, or hide text', () => {
  const body = composeBody(
    { ...DRAFT, done: `${marker('hx-ffffffffffffffff')}\n\u001b[31mred‮txt.exe` },
    'en',
  )
  expect(extractHandoffId(body.body)).toBeNull()
  expect(body.body).not.toContain('\u001b')
  expect(body.body).not.toContain('‮')
})

test('the same handoff to the same session has one fingerprint; another session, another', async () => {
  const a = await fingerprint('name:api-worker', '## Goal\nShip  it\n\n')
  const b = await fingerprint('NAME:api-worker ', '## Goal\n  Ship it')
  const c = await fingerprint('name:web-worker', '## Goal\nShip it')
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

const GUARD: HandoffGuard = { id: 'hx-0123456789abcdef', reason: 'received', since: 1000, until: 121_000, turnOpen: true }
const HANDOFF_TEXT = `hello\n${marker('hx-0123456789abcdef')}`

test('a handoff marker leaves only from this mod', () => {
  const base = { guard: null, now: 0, replyGuard: true }
  expect(judgeSend({ ...base, origin: { kind: 'model' }, text: HANDOFF_TEXT })).toMatchObject({
    allow: false,
    code: 'forward',
  })
  expect(judgeSend({ ...base, origin: { kind: 'plugin', name: 'other' }, text: HANDOFF_TEXT })).toMatchObject({
    allow: false,
    code: 'forward',
  })
  expect(
    judgeSend({ ...base, guard: GUARD, now: 2000, origin: { kind: 'plugin', name: 'session-handoff' }, text: HANDOFF_TEXT }),
  ).toEqual({ allow: true })
})

test('while the guard stands the main model sends nothing; agents and plugins still do', () => {
  const base = { guard: GUARD, now: 2000, replyGuard: true, text: 'Got it, thanks!' }
  expect(judgeSend({ ...base, origin: { kind: 'model' } })).toMatchObject({ allow: false, code: 'reply-loop' })
  expect(judgeSend({ ...base, origin: { kind: 'model' }, agentId: 'sub-1' })).toEqual({ allow: true })
  expect(judgeSend({ ...base, origin: { kind: 'plugin', name: 'notes' } })).toEqual({ allow: true })
  expect(judgeSend({ ...base, origin: { kind: 'model' }, replyGuard: false })).toEqual({ allow: true })
  expect(judgeSend({ ...base, origin: { kind: 'model' }, guard: null })).toEqual({ allow: true })
})

test('the guard ends with its time once its turn is over, and at the turn bound regardless', () => {
  expect(isGuardActive(null, 0)).toBe(false)
  expect(isGuardActive({ ...GUARD, turnOpen: false }, 120_999)).toBe(true)
  expect(isGuardActive({ ...GUARD, turnOpen: false }, 121_000)).toBe(false)
  expect(isGuardActive(GUARD, 121_000)).toBe(true)
  expect(isGuardActive(GUARD, GUARD.since + MAX_TURN_GUARD_MS)).toBe(false)
})

test('ListAgents rows become recipients in the tool’s own spelling', () => {
  const list = candidatesFrom({
    listing: 'two sessions',
    sections: [
      {
        kind: 'local sessions',
        total: 2,
        rows: [
          { name: 'api-worker', ref: 'a1b2c3', status: 'idle' },
          { name: 'api-worker', ref: 'a1b2c3' },
        ],
      },
      { kind: 'cloud sessions', total: 1, rows: [{ id: 'session_01ABCdef234' }] },
      { kind: 'junk', rows: [null, 7, { status: 'x' }] },
    ],
  })
  expect(list).toEqual([
    {
      kind: 'name',
      value: 'api-worker [a1b2c3]',
      label: 'api-worker [a1b2c3]',
      key: 'name:api-worker [a1b2c3]',
      group: 'local sessions',
      status: 'idle',
    },
    {
      kind: 'session',
      value: 'session_01ABCdef234',
      label: 'session_01ABCdef234',
      key: 'session:session_01abcdef234',
      group: 'cloud sessions',
      status: '',
    },
  ])
  const [byName, bySession] = list
  expect(byName === undefined ? undefined : sendAddress(byName)).toBe('api-worker [a1b2c3]')
  expect(bySession === undefined ? undefined : sendAddress(bySession)).toEqual({ sessionId: 'session_01ABCdef234' })
  expect(candidatesFrom(undefined)).toEqual([])
  expect(candidatesFrom({ listing: 'No reachable agents' })).toEqual([])
})

test('a typed recipient is a session id or a name', () => {
  expect(recipientFromInput('  session_01ABCdef234 ')).toMatchObject({ kind: 'session', value: 'session_01ABCdef234' })
  expect(recipientFromInput('api-worker [a1b2c3]')).toMatchObject({ kind: 'name', value: 'api-worker [a1b2c3]' })
  expect(recipientFromInput('  \n ')).toBeNull()
})

test('a fork’s reply is read for its JSON; it fills only empty fields, redacted', () => {
  const secret = join('DB_PASSWORD=', 'correct-horse-battery')
  const reply = `Here you go:\n{"goal":"G","done":["a","b"],"decisions":"d","files":"x.ts","next":"n","acceptance":"${secret}"}\nThanks`
  const patch = parseDraftReply(reply)
  expect(patch).toEqual({ goal: 'G', done: 'a\nb', decisions: 'd', files: 'x.ts', next: 'n', acceptance: secret })

  const { draft, filled } = fillEmpty({ ...EMPTY_DRAFT, goal: 'mine' }, patch ?? {})
  expect(draft.goal).toBe('mine')
  expect(filled).toEqual(['done', 'decisions', 'files', 'next', 'acceptance'])
  expect(draft.acceptance).toBe('DB_PASSWORD=[REDACTED:secret-value]')

  expect(parseDraftReply('no json here')).toBeNull()
  expect(parseDraftReply('{not json}')).toBeNull()
  expect(parseDraftReply('{"other": 1}')).toBeNull()
})

test('the files come from the conversation’s edit calls alone', () => {
  const messages = [
    {
      role: 'assistant',
      text: 'x',
      toolUses: [
        { tool_use_id: '1', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
        { tool_use_id: '2', tool: 'Write', input: { file_path: '/repo/src/b.ts' }, isError: true },
        { tool_use_id: '3', tool: 'Read', input: { file_path: '/repo/src/c.ts' } },
        { tool_use_id: '4', tool: 'NotebookEdit', input: { notebook_path: '/elsewhere/n.ipynb' } },
        { tool_use_id: '5', tool: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      ],
    },
    { role: 'user', text: 'y', toolUses: [] },
  ]
  expect(editedFiles(messages, '/repo')).toEqual(['src/a.ts', '/elsewhere/n.ipynb'])
  expect(editedFiles({ deny: 'no' }, '/repo')).toEqual([])
})

test('token counts are grouped by three', () => {
  expect([0, 7, 999, 1000, 48000, 1234567].map(formatCount)).toEqual(['0', '7', '999', '1,000', '48,000', '1,234,567'])
})

test('the ledger drops what is old or malformed', () => {
  const now = 10 * LEDGER_MAX_AGE_MS
  const ledger = readLedger(
    {
      keep: { id: 'hx-1', to: 'name:a', label: 'a', at: now - 1000, status: 'delivered' },
      old: { id: 'hx-2', to: 'name:a', label: 'a', at: now - LEDGER_MAX_AGE_MS - 1, status: 'delivered' },
      bad: { id: 3 },
    },
    isSentEntry,
    now,
  )
  expect(Object.keys(ledger)).toEqual(['keep'])
  expect(readLedger('garbage', isSentEntry, now)).toEqual({})
})
