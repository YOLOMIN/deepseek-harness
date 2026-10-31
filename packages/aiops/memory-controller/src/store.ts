/**
 * Durable file of agent-recorded memories and the recall configuration.
 *
 * Short-term memories are recorded deliberately by managed agents through the
 * `memory_record` tool; promotion moves one into the long-term tier. Every
 * entry is stored — nothing is projected from session logs. Writes are atomic
 * (sibling temporary file, then rename) and every read revalidates the full
 * document at the durable boundary.
 *
 * @module @gac2/dsh-aiops-memory-controller/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/** One agent-recorded short-term memory. */
export interface RecordedMemory {
  /** `mem-<id>` identity minted at record time. */
  readonly id: string
  readonly summary: string
  /** Full conclusion text as recorded by the agent. */
  readonly text: string
  readonly sessionId: string
  /** Preset id of the recording agent. */
  readonly agentId: string
  /** Display name captured at record time. */
  readonly agentName: string
  /** Record time, epoch ms. */
  readonly time: number
}

/** One promoted long-term memory, durable beyond the source session's lifetime. */
export interface StoredMemory extends RecordedMemory {
  readonly promotedAt: number
}

const recordedSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  text: z.string(),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  time: z.number().int().nonnegative(),
})

const storedMemorySchema = recordedSchema.extend({ promotedAt: z.number().int().nonnegative() })

const recallSchema = z.object({
  enabled: z.boolean(),
  topK: z.number().int().min(1).max(10),
  shortTermTtlDays: z.number().int().min(1).max(365).optional(),
})

/** Persisted recall configuration; the TTL override is absent until set from the console. */
export interface StoredRecallConfig {
  enabled: boolean
  topK: number
  shortTermTtlDays?: number | undefined
}

/** Recall-configuration patch accepted by {@link MemoryStore.saveRecall}. */
export interface RecallPatch {
  readonly enabled?: boolean | undefined
  readonly topK?: number | undefined
  readonly shortTermTtlDays?: number | undefined
}

const documentSchema = z.object({
  shortTerm: z.array(recordedSchema).default([]),
  longTerm: z.array(storedMemorySchema).default([]),
  recall: recallSchema.default({ enabled: true, topK: 3 }),
})

interface MemoryDocument {
  shortTerm: RecordedMemory[]
  longTerm: StoredMemory[]
  recall: StoredRecallConfig
}

/** Default recall configuration of a fresh store. */
export const DEFAULT_RECALL: StoredRecallConfig = { enabled: true, topK: 3 }

/**
 * Read-modify-write owner of the memory JSON file. Instances are cheap but
 * single-process: the owning controller serializes mutations through its calls.
 */
export class MemoryStore {
  private document: MemoryDocument | undefined

  /**
   * @param path - absolute store JSON path; the parent directory is created on first write.
   */
  constructor(private readonly path: string) {}

  /**
   * Load and cache the document; a missing file means an empty store with default recall.
   * @returns the cached document.
   * @throws when the file exists but does not parse or fails document validation.
   */
  async load(): Promise<MemoryDocument> {
    if (this.document !== undefined) return this.document
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.document = { shortTerm: [], longTerm: [], recall: { ...DEFAULT_RECALL } }
        return this.document
      }
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    this.document = documentSchema.parse(parsed)
    return this.document
  }

  /** Append one agent-recorded short-term memory and persist. */
  async record(entry: RecordedMemory): Promise<void> {
    const document = await this.load()
    document.shortTerm = [...document.shortTerm, entry]
    await this.persist()
  }

  /**
   * Move one short-term memory into the long-term tier.
   * @param id - memory identity.
   * @returns the promoted entry, or undefined when the id is not short-term.
   */
  async promote(id: string): Promise<StoredMemory | undefined> {
    const document = await this.load()
    if (document.longTerm.some(row => row.id === id)) return document.longTerm.find(row => row.id === id)
    const found = document.shortTerm.find(row => row.id === id)
    if (found === undefined) return undefined
    const entry: StoredMemory = { ...found, promotedAt: Date.now() }
    document.shortTerm = document.shortTerm.filter(row => row.id !== id)
    document.longTerm = [...document.longTerm, entry]
    await this.persist()
    return entry
  }

  /**
   * Forget one memory from whichever tier holds it.
   * @param id - memory identity.
   * @returns true when an entry was removed.
   */
  async forget(id: string): Promise<boolean> {
    const document = await this.load()
    const shortBefore = document.shortTerm.length
    const longBefore = document.longTerm.length
    document.shortTerm = document.shortTerm.filter(row => row.id !== id)
    document.longTerm = document.longTerm.filter(row => row.id !== id)
    const removed = document.shortTerm.length !== shortBefore || document.longTerm.length !== longBefore
    if (removed) await this.persist()
    return removed
  }

  /** Apply one recall-configuration patch and persist. */
  async saveRecall(patch: RecallPatch): Promise<StoredRecallConfig> {
    const document = await this.load()
    document.recall = {
      enabled: patch.enabled ?? document.recall.enabled,
      topK: patch.topK ?? document.recall.topK,
      shortTermTtlDays: patch.shortTermTtlDays ?? document.recall.shortTermTtlDays,
    }
    await this.persist()
    return document.recall
  }

  /**
   * Drop short-term entries older than `ttlMs`; persists only when something
   * was dropped. Long-term entries never expire.
   * @param ttlMs - short-term retention window in milliseconds.
   * @param now - reference time, injectable for deterministic tests.
   * @returns how many entries were dropped.
   */
  async purgeExpired(ttlMs: number, now = Date.now()): Promise<number> {
    const document = await this.load()
    const alive = document.shortTerm.filter(row => now - row.time < ttlMs)
    const dropped = document.shortTerm.length - alive.length
    if (dropped > 0) {
      document.shortTerm = alive
      await this.persist()
    }
    return dropped
  }

  private async persist(): Promise<void> {
    if (this.document === undefined) throw new Error('memory store not loaded')
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}
