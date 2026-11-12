// session-handoff: the values the mod keeps in `$.state`, and their shapes.

export type HandoffField = 'goal' | 'done' | 'decisions' | 'files' | 'next' | 'acceptance'

export type HandoffDraft = {
  goal: string
  done: string
  decisions: string
  files: string
  next: string
  acceptance: string
}

/** Whom a handoff goes to: a session id, or a name as ListAgents lists it. */
export type HandoffRecipient = {
  kind: 'name' | 'session'
  value: string
  label: string
  /** What the duplicate check keys on. */
  key: string
}

export type HandoffCandidate = HandoffRecipient & { group: string; status: string }

export type HandoffCandidates = { list: HandoffCandidate[]; error: string; at: number }

export type HandoffRedaction = { kind: string; count: number }

/** The exact message the person reviews, frozen until they edit again. */
export type HandoffReview = {
  fp: string
  id: string
  text: string
  to: HandoffRecipient
  redactions: HandoffRedaction[]
  truncated: HandoffField[]
  /** When this same handoff was already sent; 0 when it was not. */
  duplicateAt: number
  duplicateLabel: string
}

export type HandoffStatus = { tone: 'info' | 'success' | 'warning' | 'error'; text: string }

/** While it stands, the main conversation's model sends no message. */
export type HandoffGuard = {
  id: string
  reason: 'received' | 'reply-to-sent'
  since: number
  until: number
  /** The turn that read the delivery has not ended yet. */
  turnOpen: boolean
}

export type HandoffSent = { id: string; at: number; label: string }

export type HandoffInboxEntry = { id: string; at: number; preview: string }

declare module 'claude-code' {
  interface PluginState {
    'session-handoff': {
      draft: Shaped<HandoffDraft>
      recipient: Shaped<HandoffRecipient | null>
      manual: string
      candidates: Shaped<HandoffCandidates>
      review: Shaped<HandoffReview | null>
      status: Shaped<HandoffStatus>
      busy: string
      guard: Shaped<HandoffGuard | null>
      lastSent: Shaped<HandoffSent | null>
      inbox: Shaped<HandoffInboxEntry[]>
    }
  }
}
