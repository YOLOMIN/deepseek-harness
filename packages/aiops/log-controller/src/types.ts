/**
 * Wire vocabulary of the aiopsLogs Remote namespace: agent activity log rows,
 * filterable paged queries, and the failure taxonomy.
 *
 * @module @gac2/dsh-aiops-log-controller/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Log category discriminator; the console localizes the labels. */
export type AiopsLogKind = 'run' | 'model' | 'tool' | 'decision'

/** Log severity discriminator; the console localizes the labels. */
export type AiopsLogLevel = 'info' | 'warn' | 'error'

/** One projected agent-activity log row. */
export interface AiopsLogRow {
  /** Stable row identity: `<sessionId>:<seq>`. */
  readonly id: string
  /** Event time in Unix epoch milliseconds. */
  readonly time: number
  /** Severity for display. */
  readonly level: AiopsLogLevel
  /** Category for display and filtering. */
  readonly kind: AiopsLogKind
  /** Display name of the agent (preset) that produced the event. */
  readonly agent: string
  /** One-line summary. */
  readonly summary: string
  /** Owning session; the console opens its trace for details. */
  readonly sessionId: string
}

/** A projected row before the controller assigns the agent display name. */
export type AiopsLogRowDraft = Omit<AiopsLogRow, 'agent'>

/** Filtered paged query accepted by the aiopsLogs namespace. */
export interface AiopsLogQuery {
  /** Case-insensitive substring matched against row summaries. */
  readonly keyword?: string | undefined
  /** Category filter; absence matches every category. */
  readonly kind?: AiopsLogKind | undefined
  /** Inclusive lower bound on event time, epoch milliseconds. */
  readonly fromMs?: number | undefined
  /** Inclusive upper bound on event time, epoch milliseconds. */
  readonly toMs?: number | undefined
  /** 1-based page number. */
  readonly page: number
  /** Page size, capped by the controller schema. */
  readonly pageSize: number
}

/** One page of filtered log rows. */
export interface AiopsLogPage {
  /** Filtered row count before paging. */
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsLogRow[]
}

/** One log row with its full committed event payload, for the in-place detail view and per-row export. */
export interface AiopsLogDetail {
  readonly row: AiopsLogRow
  /** The owning event's data payload. */
  readonly data: JsonValue
  /** The owning event's discriminant. */
  readonly eventType: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed query input; the field names the first offending member. */
    'aiops-logs/invalid': { readonly field: string }
  }
}
