/**
 * Agent activity logs for the operations console: projects committed session
 * events of the console-managed agents (plus the inner delegation targets) into
 * filterable paged rows, served through the `aiopsLogs` Remote namespace.
 *
 * @module @gac2/dsh-aiops-log-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@gac2/dsh-aiops-agent-controller'
import { z as zod } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { effectiveAgentPreset, eventToLogRow, pairToolCall, sessionToLogRows, toolCallFacts } from './projection.ts'
import type { AiopsLogDetail, AiopsLogPage, AiopsLogQuery, AiopsLogRow, AiopsLogRowDraft } from './types.ts'

export type * from './types.ts'

/** Deployment choices for the agent-activity log projection. */
export interface Config {
  /** Newest sessions inspected per query per preset set. */
  maxSessions: number
  /** Inner delegation targets whose sessions also feed the log view. */
  innerPresetIds: string[]
}

/** Validated deployment choices. */
export const Config = z.object({
  maxSessions: z.number().min(1).max(500).default(30),
  innerPresetIds: z.array(z.string().min(1)).default(['sys-agent', 'hpc-agent']),
})

const querySchema = zod.object({
  keyword: zod.string().trim().optional(),
  kind: zod.union([zod.literal('run'), zod.literal('model'), zod.literal('tool'), zod.literal('decision')]).optional(),
  fromMs: zod.number().int().nonnegative().optional(),
  toMs: zod.number().int().nonnegative().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(200),
})

const detailSchema = zod.object({
  sessionId: zod.string().min(1),
  seq: zod.number().int().min(1),
})

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-logs/invalid', message, { field })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent-activity log query owner for the operations console. */
    aiopsLogController: AiopsLogController
  }
}

/**
 * Host owner of the `aiopsLogs` namespace. Reads are computed from the durable
 * session logs on every query — no shadow store to drift; the console's
 * "详情" opens the owning session's trace rather than a second log copy.
 */
export class AiopsLogController extends TypertRemoteService {
  static readonly inject = ['sessionQuery', 'aiopsAgentController', 'agentPresets']

  private readonly config: Config

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsLogController', { namespace: 'aiopsLogs' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
  }

  /**
   * Query agent activity rows of the console-managed agents and inner delegation targets.
   * @param input - keyword/category/time filters plus paging.
   * @returns the filtered page with its pre-paging total.
   */
  @Remote('query')
  async query(input: AiopsLogQuery): Promise<AiopsLogPage> {
    const parsed = querySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const presets = new Set([...await this.ctx.aiopsAgentController.managedPresetIds(), ...this.config.innerPresetIds])
    const names = await this.agentNames()
    // 不按 header 预筛：空白会话经 agent-preset/selected 事件后才归属预设，header 可能为空。
    const candidates = (await this.ctx.sessionQuery.listSessions()).slice(0, this.config.maxSessions)
    // 并行读取：串行解压+回放校验会随会话数线性放大首查耗时；读失败的会话跳过而非拖垮整页
    const snapshots = await Promise.all(candidates.map(async (record) => {
      try {
        return { record, snapshot: await this.ctx.sessionQuery.readSession(record.header.id) }
      } catch (error: unknown) {
        this.ctx.logger.warn(`aiops-logs: session ${record.header.id} unreadable, skipped: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }))
    const rows: Array<{ draft: AiopsLogRowDraft; search: string; agentId: string }> = []
    for (const entry of snapshots) {
      if (entry === undefined) continue
      const preset = effectiveAgentPreset(entry.record.header.agentPreset, entry.snapshot.events)
      if (preset === undefined || !presets.has(preset)) continue
      for (const projection of sessionToLogRows(entry.record.header.id, entry.snapshot.events)) {
        rows.push({ draft: projection.row, search: projection.search, agentId: preset })
      }
    }
    const keyword = parsed.data.keyword?.toLowerCase()
    const filtered = rows
      .filter(entry => parsed.data.kind === undefined || entry.draft.kind === parsed.data.kind)
      .filter(entry => parsed.data.fromMs === undefined || entry.draft.time >= parsed.data.fromMs)
      .filter(entry => parsed.data.toMs === undefined || entry.draft.time <= parsed.data.toMs)
      .filter(entry => keyword === undefined || keyword === '' || entry.search.toLowerCase().includes(keyword))
      .sort((a, b) => b.draft.time - a.draft.time)
      .map((entry): AiopsLogRow => ({ ...entry.draft, agent: names.get(entry.agentId) ?? entry.agentId }))
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: filtered.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: filtered.slice(start, start + parsed.data.pageSize),
    }
  }

  /** Preset id to display-name map from the registry; unknown ids render as-is. */
  private async agentNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    for (const preset of await this.ctx.agentPresets.list()) {
      names.set(preset.id, preset.name ?? preset.id)
    }
    return names
  }

  /**
   * Read one row's full committed event payload for the in-place detail view and per-row export.
   * @param input - owning session id and event seq.
   * @returns the projected row beside the raw event data.
   */
  @Remote('detail')
  async detail(input: { readonly sessionId: string; readonly seq: number }): Promise<AiopsLogDetail> {
    const parsed = detailSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `详情参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const snapshot = await this.ctx.sessionQuery.readSession(SessionId(parsed.data.sessionId))
    const tools = toolCallFacts()
    let target
    for (const event of snapshot.events) {
      if (event.type === 'tool/call') {
        pairToolCall(tools, event)
        continue
      }
      if (event.seq === parsed.data.seq) target = event
    }
    if (target === undefined) {
      throw new RemoteError('aiops-logs/invalid', `事件不存在：${parsed.data.sessionId}#${parsed.data.seq}`, { field: 'seq' })
    }
    const projection = eventToLogRow(parsed.data.sessionId, target, tools)
    if (projection === undefined) {
      throw new RemoteError('aiops-logs/invalid', `事件 ${parsed.data.seq} 不投影为日志行`, { field: 'seq' })
    }
    // Durable event data is JSON by construction; the round-trip also drops undefined members.
    const data = JSON.parse(JSON.stringify(target.data)) as JsonValue
    const preset = effectiveAgentPreset(snapshot.session.agentPreset, snapshot.events)
    const agent = preset === undefined ? '未知智能体' : ((await this.agentNames()).get(preset) ?? preset)
    return { row: { ...projection.row, agent }, data, eventType: target.type }
  }
}

export default AiopsLogController
