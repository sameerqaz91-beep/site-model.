// session-handoff: hand work off to another Claude session.
//
// /handoff opens a pane: pick the receiving session (from ListAgents, or an
// id typed by hand), fill or draft the six parts of the brief, review the
// exact text, then send it with `$.session.send`. Nothing is ever sent
// without that press. The same mod, in the receiving session, drops a
// handoff that arrives twice and pauses the model's own messages for a
// moment after one arrives, so two sessions cannot auto-reply in a loop.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  HandoffCandidate,
  HandoffCandidates,
  HandoffDraft,
  HandoffField,
  HandoffRecipient,
  HandoffReview,
  HandoffStatus,
} from '../types'
import {
  EMPTY_DRAFT,
  FIELD_KEYS,
  MAX_MESSAGE_CHARS,
  REQUIRED,
  STRINGS,
  candidatesFrom,
  composeBody,
  composeMessage,
  describeRedactions,
  describeUsage,
  draftPrompt,
  editedFiles,
  extractHandoffId,
  fill,
  fillEmpty,
  fingerprint,
  firstLine,
  formatTime,
  handoffId,
  hasMarker,
  isGuardActive,
  isReceivedEntry,
  isSentEntry,
  judgeSend,
  langOf,
  parseDraftReply,
  readLedger,
  recipientFromInput,
  redact,
  sendAddress,
  sentInLastHour,
} from './core'
import type { Lang, Strings } from './core'

const PANE = 'session-handoff'
const SENT_KEY = 'sent'
const RECEIVED_KEY = 'received'

// Each value is kept under a shape tag: bump the tag when its fields change,
// and what an earlier version stored reads as the initial value.
const draftAtom = atom({ plugin: 'session-handoff', key: 'draft' } as const, EMPTY_DRAFT, {
  shape: 'draft-1',
})
const recipientAtom = atom({ plugin: 'session-handoff', key: 'recipient' } as const, null, {
  shape: 'recipient-1',
})
const manualAtom = atom({ plugin: 'session-handoff', key: 'manual' } as const, '')
const candidatesAtom = atom(
  { plugin: 'session-handoff', key: 'candidates' } as const,
  { list: [], error: '', at: 0 },
  { shape: 'candidates-1' },
)
const reviewAtom = atom({ plugin: 'session-handoff', key: 'review' } as const, null, {
  shape: 'review-1',
})
const statusAtom = atom(
  { plugin: 'session-handoff', key: 'status' } as const,
  { tone: 'info', text: '' },
  { shape: 'status-1' },
)
const busyAtom = atom({ plugin: 'session-handoff', key: 'busy' } as const, '')
const guardAtom = atom({ plugin: 'session-handoff', key: 'guard' } as const, null, {
  shape: 'guard-1',
})
const lastSentAtom = atom({ plugin: 'session-handoff', key: 'lastSent' } as const, null, {
  shape: 'sent-1',
})
const inboxAtom = atom({ plugin: 'session-handoff', key: 'inbox' } as const, [], {
  shape: 'inbox-1',
})
const draftUsageAtom = atom({ plugin: 'session-handoff', key: 'draftUsage' } as const, null, {
  shape: 'usage-1',
})

// ---------------------------------------------------------------------------
// Options, read once per load by `register`

type Config = {
  lang: Lang
  t: Strings
  dir: 'rtl' | undefined
  separator: string
  replyGuard: boolean
  cooldownMs: number
  maxPerHour: number
}

function numberOption(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)

  return value !== undefined && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function configFrom(options: PluginOptions): Config {
  const lang = langOf(options.language)

  return {
    lang,
    t: STRINGS[lang],
    dir: lang === 'ar' ? 'rtl' : undefined,
    separator: lang === 'ar' ? '، ' : ', ',
    replyGuard: options.replyGuard !== false,
    cooldownMs: numberOption(options.replyCooldownSeconds, 0, 3600, 120) * 1000,
    maxPerHour: numberOption(options.maxHandoffsPerHour, 1, 100, 10),
  }
}

let cfg = configFrom({})

// One press at a time: each is taken before the handler's first await, so a
// second press in the same moment finds it taken. A reload starts them over.
let isSending = false
let isDrafting = false
const receiving = new Set<string>()

const TONE_COLOR = { success: 'success', warning: 'warning', error: 'error' } as const

function errorText(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error), 200)
}

function fieldNames(keys: readonly HandoffField[]): string {
  return keys.map(key => cfg.t.fields[key]).join(cfg.separator)
}

/** The goal from the handoff's summary line, wherever the delivery's envelope puts it. */
function previewOf(text: string): string {
  const prefixes = [STRINGS.ar.message.firstLine, STRINGS.en.message.firstLine].map(
    line => line.split('{goal}')[0] ?? line,
  )
  for (const line of text.split('\n')) {
    const prefix = prefixes.find(one => line.includes(one))
    if (prefix !== undefined) return firstLine(line.slice(line.indexOf(prefix) + prefix.length), 120)
  }

  return firstLine(text, 120)
}

// ---------------------------------------------------------------------------
// What the pane's controls do

async function say($: EngineInterface, tone: HandoffStatus['tone'], text: string): Promise<void> {
  await update($, statusAtom, () => ({ tone, text }))
}

async function clearReview($: EngineInterface): Promise<void> {
  if ((await read($, reviewAtom)) !== null) await update($, reviewAtom, () => null)
}

/** What the person typed wins over what they picked from the list. */
async function currentRecipient($: EngineInterface): Promise<HandoffRecipient | null> {
  return recipientFromInput(await read($, manualAtom)) ?? (await read($, recipientAtom))
}

async function isSelf($: EngineInterface, recipient: HandoffRecipient): Promise<boolean> {
  if (recipient.kind !== 'session') return false

  return (await $.session.id()).toLowerCase() === recipient.value.toLowerCase()
}

async function refresh($: EngineInterface): Promise<void> {
  await update($, busyAtom, () => 'listing')
  let next: HandoffCandidates
  try {
    const ran = await $.tool.call({ tool: 'ListAgents' })
    const at = await $.clock.now()
    if (ran.deny !== undefined) next = { list: [], error: firstLine(ran.deny, 200), at }
    else if (ran.isError === true) next = { list: [], error: firstLine(ran.text ?? 'ListAgents', 200), at }
    else next = { list: candidatesFrom(ran.result), error: '', at }
  } catch (error) {
    next = { list: [], error: errorText(error), at: await $.clock.now() }
  }
  await update($, candidatesAtom, () => next)
  await update($, busyAtom, busy => (busy === 'listing' ? '' : busy))
}

async function pick($: EngineInterface, candidate: HandoffCandidate): Promise<void> {
  const recipient: HandoffRecipient = {
    kind: candidate.kind,
    value: candidate.value,
    label: candidate.label,
    key: candidate.key,
  }
  await update($, recipientAtom, () => recipient)
  await update($, manualAtom, () => '')
  await clearReview($)
  await say($, 'info', '')
}

async function setManual($: EngineInterface, value: string): Promise<void> {
  await update($, manualAtom, () => value)
  await clearReview($)
}

async function setField($: EngineInterface, key: HandoffField, value: string): Promise<void> {
  await update($, draftAtom, draft => ({ ...draft, [key]: value }))
  await clearReview($)
}

async function clearDraft($: EngineInterface): Promise<void> {
  await update($, draftAtom, () => EMPTY_DRAFT)
  await clearReview($)
  await say($, 'info', cfg.t.cleared)
}

/** The exact message for this draft and recipient, or the required fields it lacks. */
async function buildReview(
  $: EngineInterface,
  draft: HandoffDraft,
  to: HandoffRecipient,
): Promise<HandoffReview | { missing: HandoffField[] }> {
  const body = composeBody(draft, cfg.lang)
  if (body.missing.length > 0) return { missing: body.missing }
  const fp = await fingerprint(to.key, body.body)
  const id = handoffId(fp)
  const ledger = readLedger(await $.store.get(SENT_KEY), isSentEntry, await $.clock.now())
  const sent = ledger[fp]

  return {
    fp,
    id,
    text: composeMessage(body, id, cfg.lang),
    to,
    redactions: body.redactions,
    truncated: body.truncated,
    duplicateAt: sent?.at ?? 0,
    duplicateLabel: sent?.label ?? '',
  }
}

async function makeReview($: EngineInterface): Promise<void> {
  const { t } = cfg
  const to = await currentRecipient($)
  if (to === null) return say($, 'warning', t.needRecipient)
  if (await isSelf($, to)) return say($, 'error', t.selfSend)
  const review = await buildReview($, await read($, draftAtom), to)
  if ('missing' in review) return say($, 'warning', fill(t.needFields, { fields: fieldNames(review.missing) }))
  await update($, reviewAtom, () => review)
  await say($, 'info', '')
}

async function sendReviewed($: EngineInterface): Promise<void> {
  const { t } = cfg
  if (isSending) return say($, 'warning', t.busy)
  isSending = true
  try {
    await update($, busyAtom, () => 'sending')
    const review = await read($, reviewAtom)
    if (review === null) return

    // What goes is what the person reviewed, and only that: a draft or a
    // recipient changed since asks for a new review.
    const to = await currentRecipient($)
    const fresh = to === null ? null : await buildReview($, await read($, draftAtom), to)
    if (fresh === null || 'missing' in fresh || fresh.fp !== review.fp || fresh.text !== review.text) {
      await update($, reviewAtom, () => null)

      return say($, 'warning', t.staleReview)
    }
    if (await isSelf($, review.to)) return say($, 'error', t.selfSend)
    if (redact(review.text).redactions.length > 0) return say($, 'error', t.secretLeft)

    const now = await $.clock.now()
    const ledger = readLedger(await $.store.get(SENT_KEY), isSentEntry, now)
    const sent = ledger[review.fp]
    if (sent !== undefined) {
      await update($, reviewAtom, () => ({ ...review, duplicateAt: sent.at, duplicateLabel: sent.label }))

      return say($, 'error', fill(t.duplicate, { label: sent.label, time: formatTime(sent.at) }))
    }
    if (sentInLastHour(ledger, now) >= cfg.maxPerHour) {
      return say($, 'error', fill(t.rateLimited, { max: cfg.maxPerHour }))
    }

    // Booked before it leaves, so a second press, a reload or another
    // session on this machine finds it already on its way.
    const entry = {
      id: review.id,
      to: review.to.key,
      label: review.to.label,
      at: now,
      status: 'pending' as const,
    }
    await $.store.set(SENT_KEY, { ...ledger, [review.fp]: entry })
    await say($, 'info', t.sending)

    let isDelivered = false
    let reason = ''
    try {
      const result = await $.session.send({ to: sendAddress(review.to), text: review.text })
      isDelivered = result.isDelivered
      reason = result.reason ?? ''
    } catch (error) {
      reason = errorText(error)
    }

    const after = readLedger(await $.store.get(SENT_KEY), isSentEntry, await $.clock.now())
    if (isDelivered) {
      await $.store.set(SENT_KEY, { ...after, [review.fp]: { ...entry, status: 'delivered' } })
      await update($, lastSentAtom, () => ({ id: review.id, at: now, label: review.to.label }))
      await update($, reviewAtom, () => null)
      const words = fill(t.sent, { id: review.id, label: review.to.label })
      await say($, 'success', words)
      $.ui.toast(words)
    } else {
      // Not delivered: unbooked, so the person can try again.
      const { [review.fp]: _dropped, ...rest } = after
      await $.store.set(SENT_KEY, rest)
      await say($, 'error', fill(t.sendFailed, { reason }))
    }
  } finally {
    isSending = false
    await update($, busyAtom, busy => (busy === 'sending' ? '' : busy))
  }
}

async function draftFromConversation($: EngineInterface): Promise<void> {
  const { t } = cfg
  if (isDrafting) return say($, 'warning', t.busy)
  isDrafting = true
  try {
    await update($, busyAtom, () => 'drafting')
    await say($, 'info', t.drafting)

    // The files come from the conversation's own edit calls (their inputs
    // alone); the rest from one tool-less question to a fork of it.
    const messages = await $.session.messages()
    const edited = Array.isArray(messages) ? editedFiles(messages, await $.session.cwd()) : []
    const forked = await $.model.fork({ prompt: draftPrompt(cfg.lang) })
    // What the fork cost, as the API counted it; nothing to count when no request was made.
    if ('usage' in forked) {
      const usage = {
        input: forked.usage.input_tokens,
        cacheRead: forked.usage.cache_read_input_tokens,
        cacheWrite: forked.usage.cache_creation_input_tokens,
        output: forked.usage.output_tokens,
        at: await $.clock.now(),
      }
      await update($, draftUsageAtom, () => usage)
    }
    let patch: Partial<HandoffDraft> = {}
    let problem = ''
    if (!forked.isAnswered) {
      problem =
        forked.reason === 'nothing-to-fork' ? t.draftNothing : fill(t.draftFailed, { reason: forked.reason })
    } else {
      patch = parseDraftReply(forked.text) ?? {}
      if (Object.keys(patch).length === 0) problem = t.draftUnreadable
    }
    const proposed = (patch.files ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
    patch = { ...patch, files: [...new Set([...proposed, ...edited])].join('\n') }

    let filled: HandoffField[] = []
    await update($, draftAtom, draft => {
      const merged = fillEmpty(draft, patch)
      filled = merged.filled

      return merged.draft
    })
    if (filled.length > 0) await clearReview($)

    if (problem !== '') await say($, 'warning', problem)
    else if (filled.length === 0) await say($, 'info', t.draftNoEmpty)
    else await say($, 'success', fill(t.drafted, { fields: fieldNames(filled) }))
  } catch (error) {
    await say($, 'error', fill(t.draftFailed, { reason: errorText(error) }))
  } finally {
    isDrafting = false
    await update($, busyAtom, busy => (busy === 'drafting' ? '' : busy))
  }
}

async function raiseGuard(
  $: EngineInterface,
  id: string,
  reason: 'received' | 'reply-to-sent',
  now: number,
): Promise<void> {
  await update($, guardAtom, () => ({ id, reason, since: now, until: now + cfg.cooldownMs, turnOpen: true }))
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  cfg = configFrom(options)
  const { t, dir } = cfg

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Hand work off to another session: pick it, review the brief, send (session-handoff)',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: t.paneTitle, focus: true, rows: 32 })
    await refresh($)

    return { text: opened.isPlaced ? t.opened : fill(t.notPlaced, { reason: opened.reason }) }
  })

  // The receiving side: a handoff that arrives twice is taken, not queued
  // again; one that arrives raises the guard below.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const id = extractHandoffId(e.text)

    if (id === null) {
      // A peer's message soon after we sent a handoff is likely its
      // automatic answer: the guard keeps our model from answering back.
      const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
      if (!cfg.replyGuard || !isPeer) return next(e)
      const last = await read($, lastSentAtom)
      const now = await $.clock.now()
      if (last === null || now - last.at >= cfg.cooldownMs) return next(e)
      const queued = await next(e)
      if (queued.consumed === undefined) await raiseGuard($, last.id, 'reply-to-sent', now)

      return queued
    }

    const key = `${await $.session.id()}:${id}`
    if (receiving.has(key)) {
      $.ui.toast(fill(t.duplicateReceived, { id }))

      return { consumed: `session-handoff: duplicate handoff ${id}` }
    }
    receiving.add(key)
    try {
      const now = await $.clock.now()
      const ledger = readLedger(await $.store.get(RECEIVED_KEY), isReceivedEntry, now)
      if (ledger[key] !== undefined) {
        $.ui.toast(fill(t.duplicateReceived, { id }))

        return { consumed: `session-handoff: duplicate handoff ${id}` }
      }
      await $.store.set(RECEIVED_KEY, { ...ledger, [key]: { at: now } })

      const queued = await next(e)
      if (queued.consumed !== undefined) return queued
      if (cfg.replyGuard) await raiseGuard($, id, 'received', now)
      const preview = previewOf(e.text)
      await update($, inboxAtom, list =>
        [{ id, at: now, preview }, ...list.filter(one => one.id !== id)].slice(0, 5),
      )
      $.ui.toast(fill(t.received, { preview }))

      return queued
    } finally {
      receiving.delete(key)
    }
  }).catch(($, e, next) => next(e)) // fails open: a fault here never loses a delivery

  // Every message about to leave the session: a handoff marker only from
  // this mod, and no message of the main model's while the guard stands.
  on('session.send', async ($, e, next) => {
    const verdict = judgeSend({
      origin: e.origin,
      agentId: e.agentId,
      text: e.text,
      guard: await read($, guardAtom),
      now: await $.clock.now(),
      replyGuard: cfg.replyGuard,
    })
    if (verdict.allow) return next(e)
    $.ui.toast(verdict.code === 'forward' ? t.forwardBlocked : t.replyBlocked)

    return { isDelivered: false, reason: verdict.reason }
  }).catch(($, e, next) =>
    hasMarker(e.text) && !next.called
      ? {
          isDelivered: false,
          reason: 'session-handoff: its guard failed, so this handoff-marked message was not sent.',
        }
      : next(e),
  )

  // The turn that read a handoff is over: from here only the time part of
  // the guard stands.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await read($, guardAtom))?.turnOpen === true) {
      await update($, guardAtom, guard => (guard === null ? null : { ...guard, turnOpen: false }))
    }

    return done
  })

  // -------------------------------------------------------------------------
  // The pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Input, Text } = $.ui.resolve(e)
    const [draft, picked, manual, candidates, review, status, busy, guard, inbox, draftUsage] = await Promise.all([
      read($, draftAtom),
      read($, recipientAtom),
      read($, manualAtom),
      read($, candidatesAtom),
      read($, reviewAtom),
      read($, statusAtom),
      read($, busyAtom),
      read($, guardAtom),
      read($, inboxAtom),
      read($, draftUsageAtom),
    ])
    const now = await $.clock.now()
    const chosen = recipientFromInput(manual) ?? picked

    const statusLine =
      status.text === '' ? null : status.tone === 'info' ? (
        <Text dimColor dir={dir}>
          {status.text}
        </Text>
      ) : (
        <Text color={TONE_COLOR[status.tone]} dir={dir}>
          {status.text}
        </Text>
      )

    const guardLine =
      guard !== null && isGuardActive(guard, now) ? (
        <Text dimColor dir={dir}>
          {fill(t.guardActive, { id: guard.id, time: formatTime(guard.until) })}
        </Text>
      ) : null

    const inboxView =
      inbox.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold dir={dir}>
            {t.inboxHeading}
          </Text>
          {inbox.map(one => (
            <Text dimColor>
              {formatTime(one.at)} · {one.id} · {one.preview}
            </Text>
          ))}
        </Box>
      )

    if (review !== null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold dir={dir}>
            {t.reviewHeading}
          </Text>
          <Box flexDirection="column">
            <Text dir={dir}>{fill(t.reviewTo, { label: review.to.label })}</Text>
            <Text dimColor>
              {fill(t.reviewMeta, { id: review.id, chars: review.text.length, max: MAX_MESSAGE_CHARS })}
            </Text>
            {review.redactions.length > 0 && (
              <Text color="warning" dir={dir}>
                {fill(t.redacted, { list: describeRedactions(review.redactions) })}
              </Text>
            )}
            {review.truncated.length > 0 && (
              <Text color="warning" dir={dir}>
                {fill(t.truncated, { fields: fieldNames(review.truncated) })}
              </Text>
            )}
          </Box>
          <Box borderStyle="round" paddingX={1}>
            <Code source={review.text} wrap="wrap" />
          </Box>
          {review.duplicateAt > 0 && (
            <Text color="error" dir={dir}>
              {fill(t.duplicate, { label: review.duplicateLabel, time: formatTime(review.duplicateAt) })}
            </Text>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {review.duplicateAt === 0 && (
              <Button
                key="send"
                variant="primary"
                label={busy === 'sending' ? t.sending : t.send}
                onPress={() => sendReviewed($)}
              />
            )}
            <Button key="back" label={t.back} onPress={() => clearReview($)} />
          </Box>
          {statusLine}
          {guardLine}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold dir={dir}>
            {t.recipientHeading}
          </Text>
          {busy === 'listing' && (
            <Text dimColor dir={dir}>
              {t.listing}
            </Text>
          )}
          {candidates.error !== '' && (
            <Text color="warning" dir={dir}>
              {fill(t.listError, { error: candidates.error })}
            </Text>
          )}
          {candidates.error === '' && candidates.list.length === 0 && busy !== 'listing' && (
            <Text dimColor dir={dir}>
              {t.noCandidates}
            </Text>
          )}
          {candidates.list.map((candidate, index) => (
            <Button key={`pick-${index}`} plain onPress={() => pick($, candidate)}>
              {chosen?.key === candidate.key ? '● ' : '○ '}
              {candidate.label}{' '}
              <Text dimColor>{[candidate.group, candidate.status].filter(part => part !== '').join(' · ')}</Text>
            </Button>
          ))}
          <Input
            key="manual"
            label={t.manualLabel}
            placeholder={t.manualPlaceholder}
            value={manual}
            onInput={value => setManual($, value)}
            onSubmit={value => setManual($, value)}
          />
          <Box flexDirection="row" gap={1}>
            <Text dir={dir}>{chosen === null ? t.noneChosen : fill(t.chosen, { label: chosen.label })}</Text>
            <Button key="refresh" label={t.refresh} onPress={() => refresh($)} />
          </Box>
        </Box>

        {FIELD_KEYS.map(key => (
          <Input
            key={`field-${key}`}
            label={`${t.fields[key]}${REQUIRED.includes(key) ? t.required : ''}: `}
            placeholder={t.placeholders[key]}
            value={draft[key]}
            rows={key === 'goal' || key === 'next' || key === 'acceptance' ? 2 : 3}
            onInput={value => setField($, key, value)}
            onSubmit={value => setField($, key, value)}
          />
        ))}

        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="review" variant="primary" label={t.review} onPress={() => makeReview($)} />
          <Button
            key="draft"
            label={busy === 'drafting' ? t.drafting : t.draft}
            onPress={() => draftFromConversation($)}
          />
          <Button key="clear" label={t.clear} onPress={() => clearDraft($)} />
        </Box>
        {draftUsage !== null && (
          <Text dimColor dir={dir}>
            {describeUsage(t.draftUsage, draftUsage)}
          </Text>
        )}
        {statusLine}
        {guardLine}
        {inboxView}
      </Box>
    )
  })
}
