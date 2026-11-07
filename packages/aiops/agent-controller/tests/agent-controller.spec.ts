import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AiopsAgentController, { DEFAULT_SEED_AGENTS } from '../src/index.ts'
import { composeAgentPreset } from '../src/preset.ts'
import type { AgentDefinition } from '../src/store.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

function snapshotOf(id: string, createdAt: number, agentPreset?: string): SessionPersistenceSnapshot {
  return {
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt,
      isSeeded: false,
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    revision: SessionPersistenceRevision(`rev-${id}`),
  }
}

function persistenceOf(snapshots: SessionPersistenceSnapshot[]): SessionPersistence {
  return { list: () => Promise.resolve(snapshots) } as never
}

async function fixture(options: {
  stored?: AgentDefinition[]
  snapshots?: SessionPersistenceSnapshot[]
  staticPresetId?: string
  /** Custom seed document; combined with seed=false. */
  seedAgentsJson?: string
  /** true exercises the shipped default seeds; omitted or false uses seedAgentsJson or disables seeding. */
  seed?: boolean
  home?: string
} = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-aiops-agents-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const storePath = join(home, 'agents.json')
  if (options.stored !== undefined) await writeFile(storePath, `${JSON.stringify({ agents: options.stored })}\n`, 'utf8')
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('sessionPersistence', persistenceOf(options.snapshots ?? []))
  await ctx.plugin(AgentPresets, { default: 'os-agent' })
  await ctx.agentPresets.register({
    id: 'os-agent',
    name: '运维智能体模板',
    description: '克隆模板',
    plugins: [],
  })
  if (options.staticPresetId !== undefined) {
    await ctx.agentPresets.register({ id: options.staticPresetId, name: '静态', plugins: [] })
  }
  const plugin = ctx.plugin(AiopsAgentController, {
    storePath,
    templatePresetId: 'os-agent',
    templateWaitMs: 500,
    seedAgentsJson: options.seedAgentsJson ?? (options.seed === true ? JSON.stringify(DEFAULT_SEED_AGENTS) : '[]'),
  })
  await plugin
  return { ctx, storePath, plugin }
}

async function readStored(storePath: string): Promise<AgentDefinition[]> {
  return (JSON.parse(await readFile(storePath, 'utf8')) as { agents: AgentDefinition[] }).agents
}

describe('composeAgentPreset', () => {
  it('replaces only the persona prefix inside the template plugin list', () => {
    const preset = composeAgentPreset(
      { id: 'agent-x', name: 'X', role: 'r', personaPrefix: '新身份', createdAt: 1, updatedAt: 1 },
      {
        id: 'os-agent',
        plugins: [
          { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '模板', other: 1 } },
          { id: 'tools', name: '@deepseek-ai/dsh-tool-fs' },
        ],
      },
    )
    expect(preset).toMatchObject({ id: 'agent-x', name: 'X', description: 'r' })
    expect(preset.plugins).toEqual([
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '新身份', other: 1 } },
      { id: 'tools', name: '@deepseek-ai/dsh-tool-fs' },
    ])
  })
})

describe('AiopsAgentController', () => {
  it('lists only registry-managed agents; static template presets stay hidden', async () => {
    const { ctx } = await fixture({
      snapshots: [snapshotOf('s1', 1000, 'os-agent'), snapshotOf('s2', 2000, 'os-agent')],
    })
    const { agents } = await ctx.aiopsAgentController.remoteList()
    expect(agents).toEqual([])
  })

  it('seeds the default 运维智能体 on first boot and keeps it editable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-aiops-seed-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const { ctx } = await fixture({ home, seed: true })
    const { agents } = await ctx.aiopsAgentController.remoteList()
    expect(agents.map(row => row.id)).toEqual(['ops-agent'])
    expect(agents[0]).toMatchObject({ name: '运维智能体', sessions: 0 })
    expect(agents[0]?.personaPrefix).toContain('HPC 智能体')
    expect(ctx.agentPresets.declaration('ops-agent')).toBeDefined()

    const { agent } = await ctx.aiopsAgentController.remoteUpdate({ id: 'ops-agent', role: '统一运维入口' })
    expect(agent.role).toBe('统一运维入口')
    await ctx.fiber.dispose()

    // 重启（同目录、同注册表文件）：保留编辑，不重复播种。
    const { ctx: revived } = await fixture({ home })
    const revivedAgents = (await revived.aiopsAgentController.remoteList()).agents
    expect(revivedAgents.map(row => row.id)).toEqual(['ops-agent'])
    expect(revivedAgents[0]?.role).toBe('统一运维入口')
  })

  it('creates an agent, persists it, and registers its preset with the template', async () => {
    const { ctx, storePath } = await fixture()
    const { agent } = await ctx.aiopsAgentController.remoteCreate({
      name: '存储智能体', role: '存储故障诊断', personaPrefix: '你是存储诊断专家',
    })
    expect(agent).toMatchObject({ name: '存储智能体', role: '存储故障诊断', sessions: 0 })
    expect(agent.id).toMatch(/^agent-/)
    expect(await readStored(storePath)).toHaveLength(1)
    expect(ctx.agentPresets.declaration(agent.id)).toMatchObject({ id: agent.id, name: '存储智能体' })
  })

  it('aggregates per-preset session statistics onto the roster', async () => {
    const { ctx } = await fixture({
      snapshots: [snapshotOf('s1', 1000, 'sys-agent'), snapshotOf('s2', 2000, 'sys-agent'), snapshotOf('s3', 3000)],
      seedAgentsJson: JSON.stringify([
        { id: 'sys-agent', name: '系统智能体', role: 'r', personaPrefix: 'p' },
      ]),
    })
    const { agents } = await ctx.aiopsAgentController.remoteList()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ id: 'sys-agent', sessions: 2, lastActiveAt: 2000 })
  })

  it('rejects malformed create input at the wire boundary', async () => {
    const { ctx } = await fixture()
    await expect(ctx.aiopsAgentController.remoteCreate({ name: '', personaPrefix: 'x' }))
      .rejects.toMatchObject({ code: 'aiops-agents/invalid' })
    await expect(ctx.aiopsAgentController.remoteCreate({ name: 'x', personaPrefix: '' }))
      .rejects.toMatchObject({ code: 'aiops-agents/invalid' })
  })

  it('updates fields and re-registers the preset', async () => {
    const { ctx } = await fixture()
    const { agent } = await ctx.aiopsAgentController.remoteCreate({
      name: '旧名', personaPrefix: '旧身份',
    })
    const { agent: updated } = await ctx.aiopsAgentController.remoteUpdate({ id: agent.id, name: '新名', personaPrefix: '新身份' })
    expect(updated).toMatchObject({ id: agent.id, name: '新名' })
    expect(ctx.agentPresets.declaration(agent.id)).toMatchObject({ name: '新名' })
    await expect(ctx.aiopsAgentController.remoteUpdate({ id: 'agent-absent', name: 'x' }))
      .rejects.toMatchObject({ code: 'aiops-agents/not-found' })
  })

  it('destroys an agent and retires its preset', async () => {
    const { ctx, storePath } = await fixture()
    const { agent } = await ctx.aiopsAgentController.remoteCreate({ name: 'x', personaPrefix: 'y' })
    await expect(ctx.aiopsAgentController.remoteDestroy({ id: agent.id })).resolves.toEqual({ removed: true })
    expect(await readStored(storePath)).toEqual([])
    expect(ctx.agentPresets.declaration(agent.id)).toBeUndefined()
    await expect(ctx.aiopsAgentController.remoteDestroy({ id: agent.id }))
      .rejects.toMatchObject({ code: 'aiops-agents/not-found' })
  })

  it('refuses to destroy the seeded builtin agent while edits remain allowed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-aiops-seed-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const { ctx } = await fixture({ home, seed: true })
    const { agents } = await ctx.aiopsAgentController.remoteList()
    expect(agents[0]).toMatchObject({ id: 'ops-agent', name: '运维智能体', builtin: true })
    await expect(ctx.aiopsAgentController.remoteDestroy({ id: 'ops-agent' }))
      .rejects.toMatchObject({ code: 'aiops-agents/invalid' })
    const { agent } = await ctx.aiopsAgentController.remoteUpdate({ id: 'ops-agent', role: '统一运维入口' })
    expect(agent.role).toBe('统一运维入口')
  })

  it('re-registers stored agents after a restart', async () => {
    const stored: AgentDefinition[] = [
      { id: 'agent-kept', name: '留存', role: 'r', personaPrefix: 'p', createdAt: 1, updatedAt: 1 },
    ]
    const { ctx, storePath } = await fixture({ stored })
    await ctx.aiopsAgentController.remoteList()
    await ctx.fiber.dispose()
    void storePath

    const { ctx: revived } = await fixture({ stored })
    const { agents } = await revived.aiopsAgentController.remoteList()
    const row = agents.find(item => item.id === 'agent-kept')
    expect(row).toMatchObject({ id: 'agent-kept', name: '留存' })
    expect(revived.agentPresets.declaration('agent-kept')).toBeDefined()
  })

  it('marks a stored definition conflicting with a static preset as broken', async () => {
    const stored: AgentDefinition[] = [
      { id: 'static-taken', name: '冲突', role: 'r', personaPrefix: 'p', createdAt: 1, updatedAt: 1 },
    ]
    const { ctx } = await fixture({ stored, staticPresetId: 'static-taken' })
    const { agents } = await ctx.aiopsAgentController.remoteList()
    expect(agents.find(item => item.id === 'static-taken')?.broken).toBe('与部署声明的静态预设冲突')
  })
})
