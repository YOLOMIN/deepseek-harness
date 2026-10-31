/**
 * Experience memory for the operations console: managed agents record
 * diagnosis conclusions deliberately through the `memory_record` tool
 * (short-term tier); the console promotes them into the durable long-term
 * tier or forgets them; agents recall long-term memories on demand through
 * the `memory_recall` tool (no proactive injection, so unrelated questions
 * carry zero memory overhead). No session-log projection — only
 * agent-recorded content becomes a memory.
 *
 * @module @gac2/dsh-aiops-memory-controller
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { z as zod } from 'zod'
import { MemoryStore } from './store.ts'
import type { RecordedMemory, StoredMemory, StoredRecallConfig } from './store.ts'
import type { AiopsMemoryDetail, AiopsMemoryPage, AiopsMemoryQuery, AiopsRecallConfig, AiopsRecallConfigInput, AiopsMemoryRow } from './types.ts'

export type * from './types.ts'

/** Deployment choices for the experience-memory controller. */
export interface Config {
  /** Absolute path of the durable memory JSON file. */
  storePath: string
  /** Short-term retention window in milliseconds; expired entries are purged lazily on reads. */
  shortTermTtlMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  storePath: z.string().min(1).default(resolve(homedir(), '.dsh', 'storages', 'aiops-memories.json')),
  shortTermTtlMs: z.number().min(60_000).default(7 * 24 * 60 * 60 * 1000),
})

const listSchema = zod.object({
  keyword: zod.string().trim().optional(),
  kind: zod.union([zod.literal('short'), zod.literal('long')]).optional(),
  fromMs: zod.number().int().nonnegative().optional(),
  toMs: zod.number().int().nonnegative().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(200),
})

const idSchema = zod.object({ id: zod.string().min(1) })

const recallInputSchema = zod.object({
  enabled: zod.boolean().optional(),
  topK: zod.number().int().min(1).max(10).optional(),
  shortTermTtlDays: zod.number().int().min(1).max(365).optional(),
})

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-memory/invalid', message, { field })
}

function notFound(id: string): RemoteError {
  return new RemoteError('aiops-memory/not-found', `记忆不存在或已遗忘：${id}`, { id })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experience-memory owner for the operations console. */
    aiopsMemoryController: AiopsMemoryController
  }
}

/** One memory row with its full-text search body, stripped before the wire. */
interface SearchableRow {
  readonly row: AiopsMemoryRow
  readonly search: string
}

/** What the `memory_record` tool hands over for one deliberate capture. */
export interface MemoryRecordInput {
  readonly summary: string
  readonly text: string
  readonly sessionId: string
  /** Effective preset id of the recording agent. */
  readonly agentId: string
}

/**
 * Host owner of the `aiopsMemory` namespace and the on-demand recall used by
 * the `memory_recall` tool. The store owns every memory row
 * (short = agent-recorded, long = promoted) plus the recall configuration.
 */
export class AiopsMemoryController extends TypertRemoteService {
  static readonly inject = ['agentPresets']

  private readonly config: Config
  private readonly store: MemoryStore

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsMemoryController', { namespace: 'aiopsMemory' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
    this.store = new MemoryStore(this.config.storePath)
  }

  /** Load the store document after lazily purging expired short-term entries. */
  private async liveDocument() {
    const document = await this.store.load()
    const days = document.recall.shortTermTtlDays
    await this.store.purgeExpired(days === undefined ? this.config.shortTermTtlMs : days * 86_400_000)
    return this.store.load()
  }

  /** Recall configuration with the TTL override resolved against the deployment default. */
  private resolveRecall(stored: StoredRecallConfig): AiopsRecallConfig {
    return {
      enabled: stored.enabled,
      topK: stored.topK,
      shortTermTtlDays: stored.shortTermTtlDays ?? Math.max(1, Math.round(this.config.shortTermTtlMs / 86_400_000)),
    }
  }

  /**
   * Recall long-term memories for the `memory_recall` tool: latest promoted
   * first, optionally keyword-filtered, capped by the persisted Top-N.
   * @param query - optional case-insensitive keyword matched against summary and text.
   * @returns whether recall is enabled, and the matched memories.
   */
  async recall(query?: string): Promise<{ readonly enabled: boolean; readonly memories: readonly StoredMemory[] }> {
    const document = await this.liveDocument()
    if (!document.recall.enabled) return { enabled: false, memories: [] }
    const keyword = query?.trim().toLowerCase()
    const matched = document.longTerm
      .filter(entry => keyword === undefined || keyword === '' || `${entry.summary}\n${entry.text}`.toLowerCase().includes(keyword))
      .sort((a, b) => b.promotedAt - a.promotedAt)
      .slice(0, document.recall.topK)
    return { enabled: true, memories: matched }
  }

  /**
   * Record one short-term memory from the `memory_record` tool. The display
   * name is resolved at record time so rows survive later preset renames.
   * @param input - conclusion text and its recording context.
   * @returns the minted memory identity.
   */
  async record(input: MemoryRecordInput): Promise<{ readonly id: string }> {
    const summary = input.summary.trim()
    const text = input.text.trim()
    if (summary === '' || text === '') throw invalid('summary', '记忆摘要与结论内容不能为空')
    const preset = (await this.ctx.agentPresets.list()).find(row => row.id === input.agentId)
    const entry: RecordedMemory = {
      id: `mem-${randomUUID().slice(0, 8)}`,
      summary,
      text,
      sessionId: input.sessionId,
      agentId: input.agentId,
      agentName: preset?.name ?? input.agentId,
      time: Date.now(),
    }
    await this.store.record(entry)
    return { id: entry.id }
  }

  /**
   * Query memory rows of the console-managed agents and inner delegation targets.
   * @param input - keyword/tier/time filters plus paging.
   * @returns the filtered page with tier counts before filtering.
   */
  @Remote('list')
  async list(input: AiopsMemoryQuery): Promise<AiopsMemoryPage> {
    const parsed = listSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const document = await this.liveDocument()
    const shortRows: SearchableRow[] = document.shortTerm.map(entry => ({
      row: { id: entry.id, summary: entry.summary, kind: 'short', agent: entry.agentName, sessionId: entry.sessionId, time: entry.time },
      search: `${entry.summary}\n${entry.text}`,
    }))
    const longRows: SearchableRow[] = document.longTerm.map(entry => ({
      row: { id: entry.id, summary: entry.summary, kind: 'long', agent: entry.agentName, sessionId: entry.sessionId, time: entry.promotedAt },
      search: `${entry.summary}\n${entry.text}`,
    }))
    const all = [...longRows, ...shortRows]
    const keyword = parsed.data.keyword?.toLowerCase()
    const filtered = all
      .filter(entry => parsed.data.kind === undefined || entry.row.kind === parsed.data.kind)
      .filter(entry => parsed.data.fromMs === undefined || entry.row.time >= parsed.data.fromMs)
      .filter(entry => parsed.data.toMs === undefined || entry.row.time <= parsed.data.toMs)
      .filter(entry => keyword === undefined || keyword === '' || entry.search.toLowerCase().includes(keyword))
      .sort((a, b) => b.row.time - a.row.time)
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: filtered.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: filtered.slice(start, start + parsed.data.pageSize).map(entry => entry.row),
      shortCount: shortRows.length,
      longCount: longRows.length,
    }
  }

  /**
   * Read one memory's full conclusion text for the in-place detail view.
   * @param input - memory identity.
   * @returns the row beside its full conclusion text.
   */
  @Remote('detail')
  async detail(input: { readonly id: string }): Promise<AiopsMemoryDetail> {
    const parsed = idSchema.safeParse(input)
    if (!parsed.success) throw invalid('id', '记忆标识无效')
    const document = await this.liveDocument()
    const stored = document.longTerm.find(entry => entry.id === parsed.data.id)
    if (stored !== undefined) {
      return {
        row: { id: stored.id, summary: stored.summary, kind: 'long', agent: stored.agentName, sessionId: stored.sessionId, time: stored.promotedAt },
        text: stored.text,
      }
    }
    const recorded = document.shortTerm.find(entry => entry.id === parsed.data.id)
    if (recorded === undefined) throw notFound(parsed.data.id)
    return {
      row: { id: recorded.id, summary: recorded.summary, kind: 'short', agent: recorded.agentName, sessionId: recorded.sessionId, time: recorded.time },
      text: recorded.text,
    }
  }

  /**
   * Promote one short-term memory into the durable long-term tier.
   * @param input - memory identity.
   * @returns confirmation of the promotion.
   */
  @Remote('promote')
  async promote(input: { readonly id: string }): Promise<{ readonly promoted: true }> {
    const parsed = idSchema.safeParse(input)
    if (!parsed.success) throw invalid('id', '记忆标识无效')
    await this.liveDocument()
    const entry = await this.store.promote(parsed.data.id)
    if (entry === undefined) throw notFound(parsed.data.id)
    return { promoted: true }
  }

  /**
   * Forget one memory from whichever tier holds it.
   * @param input - memory identity.
   * @returns confirmation of the removal.
   */
  @Remote('forget')
  async forget(input: { readonly id: string }): Promise<{ readonly forgotten: true }> {
    const parsed = idSchema.safeParse(input)
    if (!parsed.success) throw invalid('id', '记忆标识无效')
    await this.liveDocument()
    if (!await this.store.forget(parsed.data.id)) throw notFound(parsed.data.id)
    return { forgotten: true }
  }

  /**
   * Read the recall configuration consumed by the `memory_recall` tool.
   * @returns the persisted recall configuration.
   */
  @Remote('getRecallConfig')
  async getRecallConfig(): Promise<AiopsRecallConfig> {
    return this.resolveRecall((await this.store.load()).recall)
  }

  /**
   * Update the recall configuration; the `memory_recall` tool reads it live on the next call.
   * @param input - partial update; absent members keep their values.
   * @returns the persisted configuration.
   */
  @Remote('saveRecallConfig')
  async saveRecallConfig(input: AiopsRecallConfigInput): Promise<AiopsRecallConfig> {
    const parsed = recallInputSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `召回配置无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    return this.resolveRecall(await this.store.saveRecall(parsed.data))
  }
}

export default AiopsMemoryController
