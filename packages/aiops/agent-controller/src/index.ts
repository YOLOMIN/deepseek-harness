/**
 * Console-managed AIOps agents: persistent registry CRUD, dynamic preset
 * lifecycle against the Agent preset registry, and the `aiopsAgents` Remote
 * namespace consumed by the console browser page.
 *
 * The console roster is driven by the registry file alone: two default agent
 * groups (系统智能体 / HPC 智能体) are seeded on first boot, and every listed
 * agent stays editable. The deployment patch's static template preset supplies
 * the tool/persona composition cloned into each dynamic agent and never appears
 * in the console roster.
 *
 * @module @gac2/dsh-aiops-agent-controller
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z as zod } from 'zod'
import { composeAgentPreset } from './preset.ts'
import { AgentStore, type AgentDefinition } from './store.ts'
import type { AiopsAgentCreateInput, AiopsAgentRow, AiopsAgentUpdateInput } from './types.ts'

export type { AgentDefinition } from './store.ts'
export type * from './types.ts'

/** Default agent seeded on first boot, per the GAC2 requirements document. */
export const DEFAULT_SEED_AGENTS: ReadonlyArray<Omit<AgentDefinition, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'ops-agent',
    name: '运维智能体',
    role: '统一运维诊断入口（内部协同 HPC 智能体与系统智能体）',
    personaPrefix: '你是操作系统智能运维平台的运维智能体。\n'
      + '你统一接收集群运维问题并组织诊断：先判断问题所属层级——应用层/集群管理层'
      + '（作业失败、队列阻塞、调度异常、MPI 通信等）交给 HPC 智能体，'
      + '系统环境层/硬件层（内核参数、文件系统、CPU/内存/磁盘/链路/GPU 等）交给系统智能体；'
      + '汇总下层结论并给出最终处置建议。显而易见的问题可直接回答。\n'
      + '处理诊断类问题时，先调用 memory_recall 召回历史诊断经验（长期记忆）作参考；\n'
      + '形成明确的故障诊断结论后，必须先调用 memory_record 工具沉淀经验'
      + '（summary 为一句话结论，detail 为完整结论与处置建议），再输出最终答复；日常问答、寒暄或链路测试不要调用这两个工具。\n'
      + '按"感知—认知—推理—决策—行动—观察"循环工作。不要自称编码智能体。\n'
      + '当最终方案包含需要下发节点执行的命令时，必须在方案末尾附加一个 ```json exec_actions 代码块，'
      + '形如 ```json exec_actions\n[{"node":"目标节点","cmd":"命令","reason":"目的"}]\n```；'
      + '只列只读取证命令（不修改、不重启、不变更），无建议动作时输出空数组；'
      + '该块供平台人工审批后自动下发，正文中不要再解释该块。\n'
      + '需要现场只读取证才能定位时，同样直接按 exec_actions 规约给出建议命令，'
      + '由平台人工审批下发执行；不要向用户索要凭据、口令或授权，'
      + '也不要让用户手工去节点执行——审批与下发通道已经具备。',
    builtin: true,
  },
]

/** Deployment choices for the console-managed agent registry. */
export interface Config {
  /** Registry JSON file; created on first write. */
  storePath: string
  /** Preset cloned as the tool/persona template for registered agents. */
  templatePresetId: string
  /** Startup deadline for the template preset to appear, in milliseconds. */
  templateWaitMs: number
  /** JSON-encoded seed definitions inserted when the registry file does not exist yet. */
  seedAgentsJson: string
}

/** Validated deployment choices. */
export const Config = z.object({
  storePath: z.string().min(1).default(resolve(homedir(), '.dsh', 'storages', 'aiops-agents.json')),
  templatePresetId: z.string().min(1).default('os-agent'),
  templateWaitMs: z.number().min(0).max(120_000).default(30_000),
  seedAgentsJson: z.string().default(JSON.stringify(DEFAULT_SEED_AGENTS)),
})


const createSchema = zod.object({
  name: zod.string().trim().min(1),
  role: zod.string().trim().optional(),
  personaPrefix: zod.string().trim().min(1),
})

const updateSchema = zod.object({
  id: zod.string().min(1),
  name: zod.string().trim().min(1).optional(),
  role: zod.string().trim().optional(),
  personaPrefix: zod.string().trim().min(1).optional(),
})

const removeSchema = zod.object({ id: zod.string().min(1) })

const seedSchema = zod.array(zod.object({
  id: zod.string().min(1),
  name: zod.string().min(1),
  role: zod.string(),
  personaPrefix: zod.string().min(1),
  builtin: zod.boolean().optional(),
}))

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-agents/invalid', message, { field })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Console-managed agent registry and its Remote namespace owner. */
    aiopsAgentController: AiopsAgentController
  }
}

/**
 * Host owner of the `aiopsAgents` namespace. Preset registration happens here
 * (not in the browser): create/update/destroy persist the registry file first,
 * then register or retire the preset against `agentPresets`.
 */
export class AiopsAgentController extends TypertRemoteService {
  static readonly inject = ['agentPresets', 'sessionPersistence']

  private readonly store: AgentStore
  private readonly registered = new Map<string, () => Promise<void>>()
  private readonly conflicts = new Set<string>()
  private readonly ready: Promise<void>

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsAgentController', { namespace: 'aiopsAgents' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
    this.store = new AgentStore(resolve(resolved.storePath))
    this.ready = this.initialize()
    // Readiness failures surface through Remote calls; keep them from becoming unhandled rejections.
    this.ready.catch(() => undefined)
    owner.effect(() => async () => { await this.teardown() }, 'aiops-agent-controller: dispose')
  }

  private readonly config: Config

  /**
   * Registry-driven roster with per-preset session statistics and registration diagnostics.
   * @returns every console-managed agent in registry order.
   */
  @Remote('list')
  async remoteList(): Promise<{ agents: AiopsAgentRow[] }> {
    await this.ready
    const presets = new Map((await this.ctx.agentPresets.list()).map(preset => [preset.id, preset]))
    const stats = await this.sessionStats()
    const agents = (await this.store.load()).map((definition) => {
      const stat = stats.get(definition.id)
      return {
        id: definition.id,
        name: definition.name,
        role: definition.role,
        personaPrefix: definition.personaPrefix,
        ...(definition.builtin === undefined ? {} : { builtin: definition.builtin }),
        ...this.statusOf(definition.id, presets.get(definition.id)?.broken),
        sessions: stat?.count ?? 0,
        ...(stat?.lastActiveAt === undefined ? {} : { lastActiveAt: stat.lastActiveAt }),
      }
    })
    return { agents }
  }

  /**
   * Persist and register one console-created agent.
   * @param input - create fields; the id is generated.
   * @returns the new roster row.
   */
  @Remote('create')
  async remoteCreate(input: AiopsAgentCreateInput): Promise<{ agent: AiopsAgentRow }> {
    await this.ready
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `创建参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const now = Date.now()
    const definition: AgentDefinition = {
      id: `agent-${randomUUID().slice(0, 8)}`,
      name: parsed.data.name,
      role: parsed.data.role ?? '',
      personaPrefix: parsed.data.personaPrefix,
      createdAt: now,
      updatedAt: now,
    }
    await this.registerWithTemplate(definition)
    await this.store.insert(definition)
    return { agent: this.rowOf(definition, undefined) }
  }

  /**
   * Apply one configuration edit and re-register the agent's preset.
   * @param input - id plus the fields to change.
   * @returns the updated roster row.
   */
  @Remote('update')
  async remoteUpdate(input: AiopsAgentUpdateInput): Promise<{ agent: AiopsAgentRow }> {
    await this.ready
    const parsed = updateSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `更新参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const { id, ...patch } = parsed.data
    const definition = await this.tryStore(() => this.store.update(id, patch), id)
    await this.unregister(id)
    this.conflicts.delete(id)
    await this.registerWithTemplate(definition)
    return { agent: this.rowOf(definition, undefined) }
  }

  /**
   * Retire one console-created agent: unregister its preset and drop the definition.
   * The wire name avoids `remove`, which collides with the namespace service prototype.
   * @param input - the registry id to remove.
   * @returns removal confirmation.
   */
  @Remote('destroy')
  async remoteDestroy(input: { readonly id: string }): Promise<{ removed: true }> {
    await this.ready
    const parsed = removeSchema.safeParse(input)
    if (!parsed.success) throw invalid('id', '缺少要销毁的智能体标识')
    const { id } = parsed.data
    const definition = (await this.store.load()).find(row => row.id === id)
    if (definition?.builtin === true) {
      throw new RemoteError('aiops-agents/invalid', '内置默认智能体不可销毁，可在配置中调整', { field: 'id' })
    }
    await this.tryStore(() => this.store.remove(id), id)
    await this.unregister(id)
    this.conflicts.delete(id)
    return { removed: true }
  }

  /**
   * Ids of registry-managed (console) agents, for sibling integrations such as the log projection.
   * @returns every stored agent id in registry order.
   */
  async managedPresetIds(): Promise<string[]> {
    await this.ready
    return (await this.store.load()).map(definition => definition.id)
  }

  private statusOf(id: string, presetBroken: string | undefined): { broken?: string } {
    const broken = this.conflicts.has(id) ? '与部署声明的静态预设冲突' : presetBroken
    return broken === undefined ? {} : { broken }
  }

  private rowOf(definition: AgentDefinition, broken: string | undefined): AiopsAgentRow {
    return {
      id: definition.id,
      name: definition.name,
      role: definition.role,
      personaPrefix: definition.personaPrefix,
      ...(definition.builtin === undefined ? {} : { builtin: definition.builtin }),
      ...(broken === undefined ? {} : { broken }),
      sessions: 0,
    }
  }

  private async initialize(): Promise<void> {
    if (!await this.store.exists()) await this.seed()
    // 内置定义随种子演进：persona 等托管字段以种子为准刷新（用户创建的智能体不受影响）。
    for (const seed of seedSchema.parse(JSON.parse(this.config.seedAgentsJson))) {
      const stored = (await this.store.load()).find(row => row.id === seed.id)
      const stale = stored?.builtin === true
        && (stored.personaPrefix !== seed.personaPrefix || stored.name !== seed.name || stored.role !== seed.role)
      if (stale) {
        await this.store.update(seed.id, { name: seed.name, role: seed.role, personaPrefix: seed.personaPrefix })
      }
    }
    const definitions = await this.store.load()
    if (definitions.length === 0) return
    const template = this.ctx.agentPresets.declaration(this.config.templatePresetId)
      ?? await this.waitTemplate()
    for (const definition of definitions) {
      try {
        await this.registerPreset(definition, template)
      } catch (error: unknown) {
        this.conflicts.add(definition.id)
        this.ctx.logger.warn(`aiops-agents: preset ${definition.id} failed to register: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async seed(): Promise<void> {
    const seeds = seedSchema.parse(JSON.parse(this.config.seedAgentsJson))
    const now = Date.now()
    for (const seed of seeds) {
      await this.store.insert({ ...seed, createdAt: now, updatedAt: now })
    }
  }

  private async waitTemplate(): Promise<PresetDefinition> {
    const deadline = Date.now() + this.config.templateWaitMs
    for (;;) {
      const template = this.ctx.agentPresets.declaration(this.config.templatePresetId)
      if (template !== undefined) return template
      if (Date.now() >= deadline) {
        throw new RemoteError('aiops-agents/conflict', `模板智能体 ${this.config.templatePresetId} 未就绪`, { id: this.config.templatePresetId })
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  private async registerWithTemplate(definition: AgentDefinition): Promise<void> {
    try {
      const template = await this.waitTemplate()
      await this.registerPreset(definition, template)
    } catch (error: unknown) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('aiops-agents/conflict', `智能体注册失败：${error instanceof Error ? error.message : String(error)}`, { id: definition.id }, { cause: error })
    }
  }

  private async registerPreset(definition: AgentDefinition, template: PresetDefinition): Promise<void> {
    await this.unregister(definition.id)
    this.registered.set(definition.id, await this.ctx.agentPresets.register(composeAgentPreset(definition, template)))
  }

  private async unregister(id: string): Promise<void> {
    const unregister = this.registered.get(id)
    if (unregister === undefined) return
    this.registered.delete(id)
    await unregister()
  }

  private async tryStore<T>(operation: () => Promise<T>, id: string): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      throw new RemoteError('aiops-agents/not-found', error instanceof Error ? error.message : String(error), { id }, { cause: error })
    }
  }

  private async sessionStats(): Promise<Map<string, { count: number; lastActiveAt: number }>> {
    const stats = new Map<string, { count: number; lastActiveAt: number }>()
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      const preset = snapshot.header.agentPreset
      if (preset === undefined) continue
      const row = stats.get(preset) ?? { count: 0, lastActiveAt: 0 }
      row.count += 1
      row.lastActiveAt = Math.max(row.lastActiveAt, snapshot.header.createdAt)
      stats.set(preset, row)
    }
    return stats
  }

  private async teardown(): Promise<void> {
    for (const unregister of this.registered.values()) await unregister()
    this.registered.clear()
  }
}

export default AiopsAgentController
