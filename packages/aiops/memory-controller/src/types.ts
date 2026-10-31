/**
 * Wire vocabulary of the aiopsMemory Remote namespace: experience-memory rows,
 * filtered paged queries, promotion/forget actions, recall configuration, and
 * the failure taxonomy.
 *
 * @module @gac2/dsh-aiops-memory-controller/types
 */

/** Memory tier discriminator; the console localizes the labels. */
export type AiopsMemoryKind = 'short' | 'long'

/** One experience-memory row: a projected turn conclusion (short) or a promoted durable entry (long). */
export interface AiopsMemoryRow {
  /** Stable identity: `<sessionId>:<turn>`. */
  readonly id: string
  /** One-line summary of the conclusion. */
  readonly summary: string
  /** Tier for display and filtering. */
  readonly kind: AiopsMemoryKind
  /** Display name of the agent (preset) that produced the conclusion. */
  readonly agent: string
  /** Owning session; the console opens its trace for context. */
  readonly sessionId: string
  /** Conclusion time (turn end) for short entries; promotion time for long entries, epoch ms. */
  readonly time: number
}

/** Filtered paged query accepted by the aiopsMemory namespace. */
export interface AiopsMemoryQuery {
  /** Case-insensitive substring matched against the full conclusion text. */
  readonly keyword?: string | undefined
  /** Tier filter; absence matches both tiers. */
  readonly kind?: AiopsMemoryKind | undefined
  /** Inclusive lower bound on entry time, epoch milliseconds. */
  readonly fromMs?: number | undefined
  /** Inclusive upper bound on entry time, epoch milliseconds. */
  readonly toMs?: number | undefined
  /** 1-based page number. */
  readonly page: number
  /** Page size, capped by the controller schema. */
  readonly pageSize: number
}

/** One page of filtered memory rows beside the unfiltered tier counts. */
export interface AiopsMemoryPage {
  /** Filtered row count before paging. */
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsMemoryRow[]
  /** Global short-term count (after forget suppression, before keyword/tier filters). */
  readonly shortCount: number
  /** Global long-term count. */
  readonly longCount: number
}

/** One memory row with its full conclusion text, for the in-place detail view. */
export interface AiopsMemoryDetail {
  readonly row: AiopsMemoryRow
  /** Full conclusion text. */
  readonly text: string
}

/** Recall configuration consumed live by the `memory_recall` tool and the retention purge. */
export interface AiopsRecallConfig {
  /** Whether agents may recall long-term memories through `memory_recall`. */
  readonly enabled: boolean
  /** How many long-term memories one recall call carries. */
  readonly topK: number
  /** Short-term retention window in days; entries past it are purged on the next read. */
  readonly shortTermTtlDays: number
}

/** Partial recall-configuration update. */
export interface AiopsRecallConfigInput {
  readonly enabled?: boolean | undefined
  readonly topK?: number | undefined
  readonly shortTermTtlDays?: number | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed input; the field names the first offending member. */
    'aiops-memory/invalid': { readonly field: string }
    /** The target memory does not exist (or was forgotten). */
    'aiops-memory/not-found': { readonly id: string }
  }
}
