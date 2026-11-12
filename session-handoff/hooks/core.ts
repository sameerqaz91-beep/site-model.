// session-handoff: the pure part of the mod. Nothing here touches `$`, so
// every rule (what a handoff holds, what is redacted, what counts as a
// duplicate, when a send is refused) is tested on its own.

import type {
  HandoffCandidate,
  HandoffDraft,
  HandoffField,
  HandoffGuard,
  HandoffRecipient,
  HandoffRedaction,
} from '../types'

export type Lang = 'ar' | 'en'

export const PLUGIN = 'session-handoff'
export const PROTOCOL = 'v1'

export const FIELD_KEYS: readonly HandoffField[] = [
  'goal',
  'done',
  'decisions',
  'files',
  'next',
  'acceptance',
]

/** What a receiver cannot act without: the aim, the next step, and when it is done. */
export const REQUIRED: readonly HandoffField[] = ['goal', 'next', 'acceptance']

/** Fields written as one item per line. */
const LIST_FIELDS: ReadonlySet<HandoffField> = new Set(['done', 'decisions', 'files'])

/**
 * Hard caps. Together they keep a handoff a short brief: whatever is pasted
 * into a field, the whole conversation cannot ride along.
 */
export const FIELD_LIMITS: Readonly<Record<HandoffField, number>> = {
  goal: 500,
  done: 1500,
  decisions: 1200,
  files: 1500,
  next: 600,
  acceptance: 600,
}
export const MAX_LIST_ITEMS = 20
export const MAX_FILES = 30
export const MAX_ITEM_CHARS = 300
export const MAX_MESSAGE_CHARS = 7000

export const EMPTY_DRAFT: HandoffDraft = {
  goal: '',
  done: '',
  decisions: '',
  files: '',
  next: '',
  acceptance: '',
}

// ---------------------------------------------------------------------------
// Words

export type Strings = {
  paneTitle: string
  opened: string
  notPlaced: string
  recipientHeading: string
  refresh: string
  listing: string
  noCandidates: string
  listError: string
  manualLabel: string
  manualPlaceholder: string
  chosen: string
  noneChosen: string
  fields: Readonly<Record<HandoffField, string>>
  placeholders: Readonly<Record<HandoffField, string>>
  required: string
  draft: string
  drafting: string
  drafted: string
  draftNothing: string
  draftFailed: string
  draftUnreadable: string
  draftNoEmpty: string
  draftUsage: string
  review: string
  clear: string
  cleared: string
  needRecipient: string
  needFields: string
  reviewHeading: string
  reviewTo: string
  reviewMeta: string
  redacted: string
  truncated: string
  duplicate: string
  send: string
  back: string
  sending: string
  sent: string
  sendFailed: string
  staleReview: string
  rateLimited: string
  selfSend: string
  secretLeft: string
  busy: string
  received: string
  duplicateReceived: string
  replyBlocked: string
  forwardBlocked: string
  inboxHeading: string
  guardActive: string
  message: {
    firstLine: string
    headings: Readonly<Record<HandoffField, string>>
    none: string
    footer: readonly string[]
  }
}

export const STRINGS: Readonly<Record<Lang, Strings>> = {
  ar: {
    paneTitle: 'تسليم الجلسة',
    opened: 'فُتحت لوحة تسليم الجلسة: اختر الجلسة المستقبلة، املأ الحقول، ثم راجع الرسالة قبل إرسالها.',
    notPlaced: 'لوحة التسليم مفتوحة لكنها لا تُعرض الآن: {reason}',
    recipientHeading: 'الجلسة المستقبلة',
    refresh: 'تحديث القائمة',
    listing: 'جارٍ جلب الجلسات…',
    noCandidates: 'لا توجد جلسات أخرى يمكن الوصول إليها الآن. اكتب معرّف الجلسة أو اسمها في الحقل أدناه.',
    listError: 'تعذّر جلب الجلسات ({error}). اكتب معرّف الجلسة أو اسمها يدويًا.',
    manualLabel: 'أو اكتب المعرّف/الاسم: ',
    manualPlaceholder: 'session_… أو الاسم كما يظهر في ListAgents',
    chosen: 'المستقبِل: {label}',
    noneChosen: 'لم تُختر جلسة بعد.',
    fields: {
      goal: 'الهدف',
      done: 'ما أُنجز',
      decisions: 'القرارات',
      files: 'مسارات الملفات',
      next: 'الخطوة التالية',
      acceptance: 'معيار القبول',
    },
    placeholders: {
      goal: 'ما الذي نريد تحقيقه؟',
      done: 'بند في كل سطر',
      decisions: 'قرار وسببه في كل سطر',
      files: 'مسار في كل سطر',
      next: 'أول خطوة ملموسة للجلسة المستقبلة',
      acceptance: 'كيف نعرف أن العمل اكتمل؟',
    },
    required: ' (مطلوب)',
    draft: 'صياغة من المحادثة',
    drafting: 'جارٍ صياغة مسودة من المحادثة… (يُرسل الملخص فقط، لا السجل)',
    drafted: 'مُلئت الحقول الفارغة: {fields}. راجعها وعدّلها.',
    draftNothing: 'لا توجد محادثة بعد لصياغة مسودة منها؛ املأ الحقول يدويًا.',
    draftFailed: 'تعذّرت الصياغة التلقائية ({reason})؛ املأ الحقول يدويًا.',
    draftUnreadable: 'تعذّرت قراءة المسودة المقترحة؛ املأ الحقول يدويًا.',
    draftNoEmpty: 'كل الحقول ممتلئة؛ امسح حقلًا لإعادة صياغته.',
    draftUsage:
      'استهلاك آخر صياغة: {total} رمزًا في المجموع: {input} إدخال جديد، و{cacheRead} قُرئت من الكاش، و{cacheWrite} كُتبت في الكاش، و{output} إخراج.',
    review: 'مراجعة الرسالة',
    clear: 'مسح الحقول',
    cleared: 'مُسحت الحقول.',
    needRecipient: 'اختر الجلسة المستقبلة أولًا.',
    needFields: 'املأ الحقول المطلوبة: {fields}.',
    reviewHeading: 'مراجعة قبل الإرسال: هذا النص بالضبط هو ما سيصل',
    reviewTo: 'إلى: {label}',
    reviewMeta: 'المعرّف {id} · {chars} حرفًا من {max}',
    redacted: 'حُجبت أسرار محتملة قبل الإرسال: {list}',
    truncated: 'اختُصرت حقول تجاوزت الحد: {fields}',
    duplicate: 'هذا التسليم نفسه أُرسل إلى {label} في {time}. عدّل الرسالة لإرسال تسليم جديد.',
    send: 'تأكيد الإرسال',
    back: 'رجوع للتعديل',
    sending: 'جارٍ الإرسال…',
    sent: 'أُرسل التسليم {id} إلى {label}.',
    sendFailed: 'لم يُرسل: {reason}',
    staleReview: 'تغيّرت المسودة أو المستقبِل بعد المراجعة؛ راجع الرسالة من جديد.',
    rateLimited: 'بلغتَ الحد ({max}) من التسليمات في الساعة؛ حاول لاحقًا.',
    selfSend: 'لا يمكن تسليم الجلسة إلى نفسها.',
    secretLeft: 'ما زال النص يحوي ما يشبه سرًا؛ لم يُرسل.',
    busy: 'انتظر حتى تنتهي العملية الجارية.',
    received: 'وصل تسليم: {preview}',
    duplicateReceived: 'تجاهلتُ تسليمًا مكررًا ({id}).',
    replyBlocked: 'منعتُ ردًا آليًا بعد التسليم تجنبًا لحلقة ردود.',
    forwardBlocked: 'منعتُ النموذج من إعادة توجيه رسالة تسليم.',
    inboxHeading: 'آخر التسليمات الواردة',
    guardActive: 'حماية الرد الآلي مفعّلة ({id}) حتى {time}.',
    message: {
      firstLine: 'تسليم مهمة من جلسة أخرى: {goal}',
      headings: {
        goal: 'الهدف (Goal)',
        done: 'ما أُنجز (Done)',
        decisions: 'القرارات (Decisions)',
        files: 'مسارات الملفات (Files)',
        next: 'الخطوة التالية (Next step)',
        acceptance: 'معيار القبول (Acceptance criterion)',
      },
      none: '(لا يوجد)',
      footer: [
        'هذا تسليم باتجاه واحد: تابِع العمل في هذه الجلسة ولا ترسل ردًا إلى الجلسة المرسِلة عبر SendMessage.',
        'One-way handoff: continue the work here; do not reply to the sender with SendMessage.',
      ],
    },
  },
  en: {
    paneTitle: 'Session handoff',
    opened: 'Session handoff pane opened: pick the receiving session, fill the fields, then review the message before sending.',
    notPlaced: 'The handoff pane is open but not drawn right now: {reason}',
    recipientHeading: 'Receiving session',
    refresh: 'Refresh',
    listing: 'Listing sessions…',
    noCandidates: 'No other reachable session right now. Type a session id or name below.',
    listError: 'Could not list sessions ({error}). Type a session id or name below.',
    manualLabel: 'Or type an id/name: ',
    manualPlaceholder: 'session_… or the name ListAgents shows',
    chosen: 'Recipient: {label}',
    noneChosen: 'No session chosen yet.',
    fields: {
      goal: 'Goal',
      done: 'Done',
      decisions: 'Decisions',
      files: 'File paths',
      next: 'Next step',
      acceptance: 'Acceptance criterion',
    },
    placeholders: {
      goal: 'What are we trying to achieve?',
      done: 'One item per line',
      decisions: 'One decision and its reason per line',
      files: 'One path per line',
      next: 'The first concrete step for the receiver',
      acceptance: 'How do we know the work is finished?',
    },
    required: ' (required)',
    draft: 'Draft from conversation',
    drafting: 'Drafting from the conversation… (only the summary is sent, never the log)',
    drafted: 'Filled the empty fields: {fields}. Review and edit them.',
    draftNothing: 'No conversation to draft from yet; fill the fields by hand.',
    draftFailed: 'Automatic drafting failed ({reason}); fill the fields by hand.',
    draftUnreadable: 'Could not read the proposed draft; fill the fields by hand.',
    draftNoEmpty: 'Every field is filled; clear a field to redraft it.',
    draftUsage:
      'Last draft used {total} tokens in all: {input} new input, {cacheRead} read from cache, {cacheWrite} written to cache, {output} output.',
    review: 'Review message',
    clear: 'Clear fields',
    cleared: 'Fields cleared.',
    needRecipient: 'Choose the receiving session first.',
    needFields: 'Fill the required fields: {fields}.',
    reviewHeading: 'Review before sending: this exact text is what arrives',
    reviewTo: 'To: {label}',
    reviewMeta: 'id {id} · {chars} of {max} characters',
    redacted: 'Possible secrets redacted before sending: {list}',
    truncated: 'Fields cut to their limit: {fields}',
    duplicate: 'This same handoff was sent to {label} at {time}. Edit the message to send a new one.',
    send: 'Confirm and send',
    back: 'Back to editing',
    sending: 'Sending…',
    sent: 'Handoff {id} sent to {label}.',
    sendFailed: 'Not sent: {reason}',
    staleReview: 'The draft or the recipient changed after the review; review the message again.',
    rateLimited: 'You reached the limit ({max}) of handoffs per hour; try later.',
    selfSend: 'A session cannot hand off to itself.',
    secretLeft: 'The text still holds something that looks like a secret; not sent.',
    busy: 'Wait for the running operation to finish.',
    received: 'Handoff received: {preview}',
    duplicateReceived: 'Ignored a duplicate handoff ({id}).',
    replyBlocked: 'Blocked an automatic reply right after a handoff, to avoid a reply loop.',
    forwardBlocked: 'Blocked the model from forwarding a handoff message.',
    inboxHeading: 'Latest handoffs received',
    guardActive: 'Auto-reply guard on ({id}) until {time}.',
    message: {
      firstLine: 'Handoff from another session: {goal}',
      headings: {
        goal: 'Goal',
        done: 'Done',
        decisions: 'Decisions',
        files: 'File paths',
        next: 'Next step',
        acceptance: 'Acceptance criterion',
      },
      none: '(none)',
      footer: [
        'One-way handoff: continue the work here; do not reply to the sender with SendMessage.',
      ],
    },
  },
}

/** Fills `{name}` slots; a slot with no value is left as written. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  )
}

export function langOf(value: unknown): Lang {
  return value === 'en' ? 'en' : 'ar'
}

/** `12,345`: digits grouped by three, with no locale data to lean on. */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The usage line for the last draft, every count grouped. */
export function describeUsage(
  template: string,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): string {
  const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output

  return fill(template, {
    total: formatCount(total),
    input: formatCount(usage.input),
    cacheRead: formatCount(usage.cacheRead),
    cacheWrite: formatCount(usage.cacheWrite),
    output: formatCount(usage.output),
  })
}

/** `YYYY-MM-DD HH:MM UTC`: the module has no locale data to lean on. */
export function formatTime(ms: number): string {
  const iso = new Date(ms).toISOString()

  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

// ---------------------------------------------------------------------------
// Secrets

type SecretRule = {
  kind: string
  pattern: RegExp
  /** The replacement, or null to keep the match as it is (not a secret after all). */
  replace: (match: string, groups: readonly string[]) => string | null
}

const tag = (kind: string) => `[REDACTED:${kind}]`
const whole = (kind: string) => () => tag(kind)

/** A value that names a secret without holding one: a number, a variable, a placeholder. */
const NOT_A_SECRET = /^(?:[\d.,_:-]+|\$.*|<.*|%.*%|\{.*|process\.env.*|os\.environ.*|env\(.*)$/i

/**
 * Known key and token formats, then the shapes a secret is usually written
 * in (`NAME=value`, a credential in a URL, an Authorization header). Ordered
 * from the most specific: a GitHub token inside `TOKEN=...` is named as the
 * token it is, and the assignment rule skips what is already redacted.
 */
const SECRET_RULES: readonly SecretRule[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole('private-key'),
  },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: whole('anthropic-key') },
  {
    kind: 'api-key',
    pattern: /\bsk-(?:proj-|svcacct-|live-)?[A-Za-z0-9_-]{20,}/g,
    replace: whole('api-key'),
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: whole('github-token'),
  },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: whole('gitlab-token') },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: whole('slack-token') },
  {
    kind: 'slack-webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
    replace: whole('slack-webhook'),
  },
  {
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
    replace: whole('aws-access-key'),
  },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: whole('google-api-key') },
  {
    kind: 'stripe-key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g,
    replace: whole('stripe-key'),
  },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: whole('npm-token') },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: whole('jwt'),
  },
  {
    kind: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
    replace: (_match, groups) => `${groups[0] ?? ''}${tag('url-credentials')}@`,
  },
  {
    kind: 'auth-header',
    pattern: /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_match, groups) => `${groups[0] ?? ''} ${tag('auth-header')}`,
  },
  {
    kind: 'secret-value',
    pattern:
      /\b([A-Za-z0-9_.-]{0,40}(?:secret|token|passwd|password|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?[A-Za-z0-9_.-]{0,40})(["']?\s*[:=]\s*)(["']?)(?!\[REDACTED)([^\s"'`,;[\]]{6,})\3/gi,
    replace: (_match, groups) => {
      const [name = '', separator = '', quote = '', value = ''] = groups
      if (NOT_A_SECRET.test(value)) return null

      return `${name}${separator}${quote}${tag('secret-value')}${quote}`
    },
  },
]

export type Redacted = { text: string; redactions: HandoffRedaction[] }

/** Replaces every secret the rules know with `[REDACTED:<kind>]`, counting each kind. */
export function redact(text: string): Redacted {
  const counts = new Map<string, number>()
  let out = text

  for (const rule of SECRET_RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // `replace` hands the groups, then the offset (a number), then the input.
      const offsetAt = rest.findIndex(part => typeof part === 'number')
      const groups = rest
        .slice(0, offsetAt === -1 ? 0 : offsetAt)
        .map(part => (typeof part === 'string' ? part : ''))
      const replaced = rule.replace(match, groups)
      if (replaced === null) return match
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1)

      return replaced
    })
  }

  return { text: out, redactions: [...counts].map(([kind, count]) => ({ kind, count })) }
}

export function mergeRedactions(lists: readonly (readonly HandoffRedaction[])[]): HandoffRedaction[] {
  const counts = new Map<string, number>()
  for (const list of lists) {
    for (const one of list) counts.set(one.kind, (counts.get(one.kind) ?? 0) + one.count)
  }

  return [...counts].map(([kind, count]) => ({ kind, count }))
}

export function describeRedactions(list: readonly HandoffRedaction[]): string {
  return list.map(one => `${one.kind} ×${one.count}`).join(', ')
}

// ---------------------------------------------------------------------------
// Composition

export const MARKER_RE = /\[session-handoff v1 id=(hx-[0-9a-f]{16})\]/g

export function marker(id: string): string {
  return `[session-handoff ${PROTOCOL} id=${id}]`
}

/** The id of the last handoff marker in `text`, or null when there is none. */
export function extractHandoffId(text: string): string | null {
  let id: string | null = null
  for (const match of text.matchAll(MARKER_RE)) id = match[1] ?? id

  return id
}

export function hasMarker(text: string): boolean {
  return extractHandoffId(text) !== null
}

/**
 * Plain text a person can read and a terminal cannot be steered by: CRLF made
 * LF, control characters and bidirectional overrides dropped, a marker inside
 * a field made inert so a field cannot forge another handoff's id.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/\[session-handoff/gi, '[session handoff')
    .trim()
}

function clip(text: string, max: number): { text: string; isCut: boolean } {
  if (text.length <= max) return { text, isCut: false }

  return { text: `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`, isCut: true }
}

function listItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim())
    .filter(line => line !== '')
}

export type Body = {
  /** The six sections, as hashed for the duplicate check. */
  body: string
  /** Each field as it went in, after cleaning, redaction and caps. */
  values: Readonly<Record<HandoffField, string>>
  redactions: HandoffRedaction[]
  truncated: HandoffField[]
  missing: HandoffField[]
}

/** Cleans, redacts and caps each field, then writes the six sections. */
export function composeBody(draft: HandoffDraft, lang: Lang): Body {
  const words = STRINGS[lang].message
  const values = { ...EMPTY_DRAFT }
  const redactions: HandoffRedaction[][] = []
  const truncated: HandoffField[] = []
  const missing: HandoffField[] = []
  const sections: string[] = []

  for (const key of FIELD_KEYS) {
    const { text: safe, redactions: found } = redact(sanitize(draft[key] ?? ''))
    redactions.push(found)

    let value: string
    let isCut = false
    if (LIST_FIELDS.has(key)) {
      let items = listItems(safe)
      if (key === 'files') items = [...new Set(items)]
      const limit = key === 'files' ? MAX_FILES : MAX_LIST_ITEMS
      if (items.length > limit) {
        items = items.slice(0, limit)
        isCut = true
      }
      const lines = items.map(item => {
        const one = clip(item, MAX_ITEM_CHARS)
        isCut ||= one.isCut

        return `- ${one.text}`
      })
      const joined = clip(lines.join('\n'), FIELD_LIMITS[key])
      value = joined.text
      isCut ||= joined.isCut
    } else {
      const one = clip(safe, FIELD_LIMITS[key])
      value = one.text
      isCut = one.isCut
    }

    values[key] = value
    if (isCut) truncated.push(key)
    if (value === '' && REQUIRED.includes(key)) missing.push(key)
    sections.push(`## ${words.headings[key]}\n${value === '' ? words.none : value}`)
  }

  return {
    body: sections.join('\n\n'),
    values,
    redactions: mergeRedactions(redactions),
    truncated,
    missing,
  }
}

/** The whole message: a one-line summary first (what a recipient previews), the sections, the marker last. */
export function composeMessage(body: Body, id: string, lang: Lang): string {
  const words = STRINGS[lang].message
  const goal = (body.values.goal.split('\n')[0] ?? '').trim()
  const first = fill(words.firstLine, { goal: clip(goal, 140).text })
  // The marker is never cut: the head gives way first.
  const tail = ['', '—', ...words.footer, marker(id)].join('\n')
  const head = clip([first, '', body.body].join('\n'), MAX_MESSAGE_CHARS - tail.length - 1).text

  return `${head}\n${tail}`
}

// ---------------------------------------------------------------------------
// Duplicates

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Whitespace and blank lines do not make a handoff new. */
export function normalizeForFingerprint(text: string): string {
  return text
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(line => line !== '')
    .join('\n')
}

/** The same sections to the same recipient are the same handoff. */
export function fingerprint(recipientKey: string, body: string): Promise<string> {
  return sha256Hex(
    `${PROTOCOL}\u0000${recipientKey.trim().toLowerCase()}\u0000${normalizeForFingerprint(body)}`,
  )
}

export function handoffId(fp: string): string {
  return `hx-${fp.slice(0, 16)}`
}

export const HOUR_MS = 60 * 60 * 1000
export const LEDGER_MAX_AGE_MS = 7 * 24 * HOUR_MS
export const LEDGER_MAX_ENTRIES = 300

export type SentEntry = {
  id: string
  to: string
  label: string
  at: number
  status: 'pending' | 'delivered'
}
export type SentLedger = Record<string, SentEntry>
export type ReceivedEntry = { at: number }
export type ReceivedLedger = Record<string, ReceivedEntry>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSentEntry(value: unknown): value is SentEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.to === 'string' &&
    typeof value.label === 'string' &&
    typeof value.at === 'number' &&
    (value.status === 'pending' || value.status === 'delivered')
  )
}

export function isReceivedEntry(value: unknown): value is ReceivedEntry {
  return isRecord(value) && typeof value.at === 'number'
}

/**
 * What the store holds, read defensively (an older version, a hand edit) and
 * pruned: entries past the age limit go, then the oldest past the count.
 */
export function readLedger<T extends { at: number }>(
  raw: unknown,
  isEntry: (value: unknown) => value is T,
  now: number,
): Record<string, T> {
  if (!isRecord(raw)) return {}
  const kept = Object.entries(raw)
    .filter((pair): pair is [string, T] => isEntry(pair[1]))
    .filter(([, entry]) => now - entry.at < LEDGER_MAX_AGE_MS && entry.at <= now + HOUR_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, LEDGER_MAX_ENTRIES)

  return Object.fromEntries(kept)
}

export function sentInLastHour(ledger: SentLedger, now: number): number {
  return Object.values(ledger).filter(entry => now - entry.at < HOUR_MS).length
}

// ---------------------------------------------------------------------------
// Loops

/** However long a turn runs, the turn part of the guard ends after this. */
export const MAX_TURN_GUARD_MS = 15 * 60 * 1000

export function isGuardActive(guard: HandoffGuard | null, now: number): boolean {
  if (guard === null) return false
  if (now < guard.until) return true

  return guard.turnOpen && now < guard.since + MAX_TURN_GUARD_MS
}

export type SendOrigin = { kind: 'model' } | { kind: 'plugin'; name: string }

export type SendVerdict =
  | { allow: true }
  | { allow: false; code: 'forward' | 'reply-loop'; reason: string }

/**
 * Whether a message about to leave the session goes:
 *
 * - one carrying a handoff marker goes only when this mod composed it from a
 *   person's press, so no model (here or after a forward) and no other plugin
 *   can relay a handoff on and start a forwarding loop;
 * - while the guard stands (a handoff just arrived, or a reply to one we just
 *   sent), the main conversation's model sends nothing, so an automatic "got
 *   it" cannot start a ping-pong. Subagents and teammates keep talking.
 */
export function judgeSend(input: {
  origin: SendOrigin
  agentId?: string
  text: string
  guard: HandoffGuard | null
  now: number
  replyGuard: boolean
}): SendVerdict {
  const isOurs = input.origin.kind === 'plugin' && input.origin.name === PLUGIN

  if (hasMarker(input.text) && !isOurs) {
    return {
      allow: false,
      code: 'forward',
      reason:
        'session-handoff: a message carrying a handoff marker is sent only by a person from the /handoff pane; forwarding or echoing it is blocked to prevent loops. Do not retry: continue the work in this session.',
    }
  }

  if (
    input.replyGuard &&
    input.origin.kind === 'model' &&
    input.agentId === undefined &&
    isGuardActive(input.guard, input.now)
  ) {
    return {
      allow: false,
      code: 'reply-loop',
      reason: `session-handoff: automatic replies are paused right after a handoff (${input.guard?.id ?? ''}) to prevent reply loops. Do not retry: continue the work in this session and leave any reply to the person.`,
    }
  }

  return { allow: true }
}

// ---------------------------------------------------------------------------
// Recipients

const SESSION_ID_RE = /^(?:session_[A-Za-z0-9_-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function oneLine(text: string, max: number): string {
  return clip(sanitize(text).replace(/\s+/g, ' '), max).text
}

/** A recipient the person typed: a session id, or a name as ListAgents lists it. */
export function recipientFromInput(raw: string): HandoffRecipient | null {
  const value = oneLine(raw, 200)
  if (value === '') return null
  if (SESSION_ID_RE.test(value)) {
    return { kind: 'session', value, label: value, key: `session:${value.toLowerCase()}` }
  }

  return { kind: 'name', value, label: value, key: `name:${value.toLowerCase()}` }
}

/**
 * The rows of a ListAgents result (`sections[].rows[]`), as recipients. A
 * row's address is its name, with ` [ref]` when the listing gives one (the
 * SendMessage tool's own spelling); a row with only a session id goes by it.
 */
export function candidatesFrom(result: unknown): HandoffCandidate[] {
  if (!isRecord(result) || !Array.isArray(result.sections)) return []
  const out: HandoffCandidate[] = []
  const seen = new Set<string>()

  for (const section of result.sections) {
    if (!isRecord(section) || !Array.isArray(section.rows)) continue
    const group = typeof section.kind === 'string' ? oneLine(section.kind, 40) : ''
    for (const row of section.rows) {
      if (!isRecord(row)) continue
      const name = typeof row.name === 'string' ? oneLine(row.name, 120) : ''
      const ref = typeof row.ref === 'string' ? oneLine(row.ref, 40) : ''
      const id = typeof row.id === 'string' ? oneLine(row.id, 120) : ''
      const status = typeof row.status === 'string' ? oneLine(row.status, 40) : ''
      let recipient: HandoffRecipient | null = null
      if (name !== '') {
        const value = ref === '' ? name : `${name} [${ref}]`
        recipient = { kind: 'name', value, label: value, key: `name:${value.toLowerCase()}` }
      } else if (SESSION_ID_RE.test(id)) {
        recipient = { kind: 'session', value: id, label: id, key: `session:${id.toLowerCase()}` }
      }
      if (recipient === null || seen.has(recipient.key)) continue
      seen.add(recipient.key)
      out.push({ ...recipient, group, status })
    }
  }

  return out.slice(0, 50)
}

/** What `$.session.send` takes as `to` for a recipient. */
export function sendAddress(recipient: HandoffRecipient): string | { sessionId: string } {
  return recipient.kind === 'session' ? { sessionId: recipient.value } : recipient.value
}

// ---------------------------------------------------------------------------
// Drafting

/**
 * The one question asked of a fork of this conversation: the six fields as
 * JSON. The fork reads the conversation the session already sent the model;
 * only its short answer comes back, and only after the person's review does
 * any of it leave the session.
 */
export function draftPrompt(lang: Lang): string {
  const language = lang === 'ar' ? 'Arabic' : 'English'

  return [
    'Prepare a handoff note so another Claude session can continue this work.',
    'You have no tools here: answer straight away, without deliberating.',
    'Reply with ONLY one JSON object (no prose, no code fence) with exactly these string keys:',
    '"goal": the aim, in one or two sentences;',
    '"done": what is finished, one short item per line;',
    '"decisions": decisions taken, one per line, each with its reason in a few words;',
    '"files": the relevant file paths, one per line, paths only;',
    '"next": the single next concrete step;',
    '"acceptance": one checkable criterion that says the work is finished.',
    `Rules: write in ${language} (keep paths, commands and identifiers as they are); at most 500 characters per key;`,
    'never include secrets, tokens, passwords, keys, credentials or personal data;',
    'do not quote the conversation or tool output; use "" for what you do not know.',
  ].join('\n')
}

/** The JSON object in a fork's reply, as draft fields; null when there is none. */
export function parseDraftReply(text: string): Partial<HandoffDraft> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const out: Partial<HandoffDraft> = {}
  for (const key of FIELD_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string') out[key] = value
    else if (Array.isArray(value)) {
      out[key] = value.filter((item): item is string => typeof item === 'string').join('\n')
    }
  }

  return Object.keys(out).length === 0 ? null : out
}

/**
 * Writes `patch` into the fields that are still empty, and says which; what a
 * model proposed is redacted here already, so a secret never sits in a field.
 */
export function fillEmpty(
  draft: HandoffDraft,
  patch: Partial<HandoffDraft>,
): { draft: HandoffDraft; filled: HandoffField[] } {
  const next = { ...draft }
  const filled: HandoffField[] = []
  for (const key of FIELD_KEYS) {
    const value = redact(sanitize(patch[key] ?? '')).text
    if (draft[key].trim() === '' && value !== '') {
      next[key] = clip(value, FIELD_LIMITS[key]).text
      filled.push(key)
    }
  }

  return { draft: next, filled }
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The files this conversation edited, from its tool calls' inputs alone, relative to `cwd`. */
export function editedFiles(messages: unknown, cwd: string): string[] {
  if (!Array.isArray(messages)) return []
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  const out = new Set<string>()

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.toolUses)) continue
    for (const use of message.toolUses) {
      if (!isRecord(use) || typeof use.tool !== 'string' || !EDIT_TOOLS.has(use.tool)) continue
      if (use.isError === true || !isRecord(use.input)) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string' || path.trim() === '') continue
      out.add(path.startsWith(root) ? path.slice(root.length) : path)
    }
  }

  return [...out].slice(0, MAX_FILES)
}

export function firstLine(text: string, max = 120): string {
  return oneLine(text.split('\n').find(line => line.trim() !== '') ?? '', max)
}
