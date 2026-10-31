import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AiopsMemoryController from '../src/index.ts'
import type { Config, MemoryRecordInput } from '../src/index.ts'
import { MemoryStore } from '../src/store.ts'
import { apply as applyMemoryTool } from '../src/tool.ts'

function fixture(ttlMs?: number) {
  const ctx = new Context()
  ctx.provide('agentPresets', {
    list: () => Promise.resolve([
      { id: 'ops-agent', name: '运维智能体' },
      { id: 'sys-agent', name: '系统智能体' },
    ]),
  } as never)
  const config: Config = {
    storePath: resolve(tmpdir(), `aiops-memories-test-${randomUUID()}.json`),
    shortTermTtlMs: ttlMs ?? 7 * 24 * 60 * 60 * 1000,
  }
  const controller = new AiopsMemoryController(ctx, config)
  return { ctx, controller, config }
}

function recordInput(overrides?: Partial<MemoryRecordInput>): MemoryRecordInput {
  return {
    summary: 'NFS 挂载超时根因：服务端 nfsd 无响应',
    text: '完整结论：rpcinfo 无应答指向服务端 nfsd/mountd 停止；处置：重启 nfs-server 并 exportfs -ra。',
    sessionId: 'session-1',
    agentId: 'ops-agent',
    ...overrides,
  }
}

describe('MemoryStore.purgeExpired', () => {
  const entry = (id: string, time: number) => ({ id, summary: 's', text: 't', sessionId: 's1', agentId: 'ops-agent', agentName: '运维智能体', time })

  it('drops short-term entries older than the TTL and never touches long-term entries', async () => {
    const store = new MemoryStore(resolve(tmpdir(), `aiops-memories-test-${randomUUID()}.json`))
    await store.record(entry('mem-old', 1000))
    await store.promote('mem-old')
    await store.record(entry('mem-stale', 2000))
    await store.record(entry('mem-fresh', 5000))
    const dropped = await store.purgeExpired(2000, 6000)
    expect(dropped).toBe(1)
    const document = await store.load()
    expect(document.shortTerm.map(row => row.id)).toEqual(['mem-fresh'])
    expect(document.longTerm.map(row => row.id)).toEqual(['mem-old'])
    // 无过期条目时不重写文件
    expect(await store.purgeExpired(2000, 6000)).toBe(0)
  })
})

describe('AiopsMemoryController', () => {
  const base = { page: 1, pageSize: 50 }

  it('records agent-captured conclusions into the short-term tier with resolved agent names', async () => {
    const { controller } = fixture()
    const { id } = await controller.record(recordInput())
    expect(id).toMatch(/^mem-/)
    await controller.record(recordInput({ sessionId: 'session-2', agentId: 'sys-agent' }))
    const page = await controller.list(base)
    expect(page.total).toBe(2)
    expect(page.shortCount).toBe(2)
    expect(page.longCount).toBe(0)
    expect(page.rows.map(row => row.agent).sort()).toEqual(['系统智能体', '运维智能体'])
    expect(page.rows.every(row => row.kind === 'short')).toBe(true)
  })

  it('rejects empty recordings at the service boundary', async () => {
    const { controller } = fixture()
    await expect(controller.record(recordInput({ summary: '  ' }))).rejects.toMatchObject({ code: 'aiops-memory/invalid' })
    await expect(controller.record(recordInput({ text: '' }))).rejects.toMatchObject({ code: 'aiops-memory/invalid' })
  })

  it('filters by keyword, tier, and the inclusive time range', async () => {
    const { controller } = fixture()
    await controller.record(recordInput())
    const now = Date.now()
    const hit = await controller.list({ ...base, keyword: 'nfsd' })
    expect(hit.total).toBe(1)
    expect((await controller.list({ ...base, keyword: '不存在' })).total).toBe(0)
    expect((await controller.list({ ...base, kind: 'long' })).total).toBe(0)
    expect((await controller.list({ ...base, toMs: now })).total).toBe(1)
    expect((await controller.list({ ...base, fromMs: now + 60_000 })).total).toBe(0)
  })

  it('promotes short-term memories into the long-term tier, idempotently', async () => {
    const { controller } = fixture()
    const { id } = await controller.record(recordInput())
    await controller.promote({ id })
    const page = await controller.list(base)
    expect(page.shortCount).toBe(0)
    expect(page.longCount).toBe(1)
    expect(page.rows[0]?.kind).toBe('long')
    await controller.promote({ id })
    expect((await controller.list(base)).longCount).toBe(1)
    await expect(controller.promote({ id: 'mem-absent' })).rejects.toMatchObject({ code: 'aiops-memory/not-found' })
  })

  it('reads detail from whichever tier holds the memory', async () => {
    const { controller } = fixture()
    const { id } = await controller.record(recordInput())
    const short = await controller.detail({ id })
    expect(short.row.kind).toBe('short')
    expect(short.text).toContain('rpcinfo')
    await controller.promote({ id })
    const long = await controller.detail({ id })
    expect(long.row.kind).toBe('long')
    expect(long.text).toBe(short.text)
  })

  it('forgets memories from either tier', async () => {
    const { controller } = fixture()
    const first = await controller.record(recordInput())
    const second = await controller.record(recordInput({ sessionId: 'session-2' }))
    await controller.forget({ id: first.id })
    expect((await controller.list(base)).shortCount).toBe(1)
    await controller.promote({ id: second.id })
    await controller.forget({ id: second.id })
    expect((await controller.list(base)).total).toBe(0)
    await expect(controller.forget({ id: first.id })).rejects.toMatchObject({ code: 'aiops-memory/not-found' })
  })

  it('persists memories and the recall configuration across controller instances', async () => {
    const { controller, config } = fixture()
    const { id } = await controller.record(recordInput())
    await controller.promote({ id })
    await controller.saveRecallConfig({ enabled: false, topK: 5, shortTermTtlDays: 3 })
    // 同路径新实例（新 Context）读到持久化结果
    const ctx = new Context()
    ctx.provide('agentPresets', { list: () => Promise.resolve([]) } as never)
    const reloaded = new AiopsMemoryController(ctx, config)
    expect((await reloaded.list(base)).longCount).toBe(1)
    expect(await reloaded.getRecallConfig()).toEqual({ enabled: false, topK: 5, shortTermTtlDays: 3 })
  })

  it('expires short-term memories past the retention window on the next read', async () => {
    // 预写一条超出保留期的短期记忆（直接写库文件，不依赖时钟流逝）
    const path = resolve(tmpdir(), `aiops-memories-test-${randomUUID()}.json`)
    const stale = { id: 'mem-stale', summary: 's', text: 't', sessionId: 's1', agentId: 'ops-agent', agentName: '运维智能体', time: 1000 }
    await new MemoryStore(path).record(stale)
    const ctx = new Context()
    ctx.provide('agentPresets', { list: () => Promise.resolve([]) } as never)
    const controller = new AiopsMemoryController(ctx, { storePath: path, shortTermTtlMs: 60_000 })
    const page = await controller.list(base)
    expect(page.shortCount).toBe(0)
    await expect(controller.detail({ id: 'mem-stale' })).rejects.toMatchObject({ code: 'aiops-memory/not-found' })
    await expect(controller.promote({ id: 'mem-stale' })).rejects.toMatchObject({ code: 'aiops-memory/not-found' })
  })

  it('recalls long-term memories on demand with the persisted Top-N cap and keyword filter', async () => {    const { controller } = fixture()
    const first = await controller.record(recordInput({ summary: 'NFS 挂载超时根因：nfsd 无响应' }))
    await controller.promote({ id: first.id })
    const second = await controller.record(recordInput({ summary: 'GPU 温度过高处置', text: '完整结论：清灰与风扇更换。' }))
    await controller.promote({ id: second.id })
    await controller.saveRecallConfig({ topK: 1 })
    const capped = await controller.recall()
    expect(capped.enabled).toBe(true)
    expect(capped.memories).toHaveLength(1)
    const filtered = await controller.recall('GPU')
    expect(filtered.memories.map(entry => entry.summary)).toEqual(['GPU 温度过高处置'])
    // 短期记忆不参与召回
    await controller.record(recordInput({ summary: 'GPU 短期未晋升' }))
    expect((await controller.recall('GPU')).memories).toHaveLength(1)
    await controller.saveRecallConfig({ enabled: false })
    const disabled = await controller.recall()
    expect(disabled.enabled).toBe(false)
    expect(disabled.memories).toHaveLength(0)
  })

  it('rejects malformed inputs at the wire boundary', async () => {
    const { controller } = fixture()
    await expect(controller.list({ page: 0, pageSize: 50 })).rejects.toMatchObject({ code: 'aiops-memory/invalid' })
    await expect(controller.saveRecallConfig({ topK: 0 })).rejects.toMatchObject({ code: 'aiops-memory/invalid' })
    await expect(controller.promote({ id: '' })).rejects.toMatchObject({ code: 'aiops-memory/invalid' })
  })
})

describe('memory tools', () => {
  interface CapturedTool { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }

  function toolFixture() {
    const ctx = new Context()
    const registered: CapturedTool[] = []
    ctx.provide('tools', { register: (tool: CapturedTool) => { registered.push(tool); return () => undefined } } as never)
    const calls: MemoryRecordInput[] = []
    ctx.provide('aiopsMemoryController', {
      record: (input: MemoryRecordInput) => { calls.push(input); return Promise.resolve({ id: 'mem-test01' }) },
      recall: (query?: string) => Promise.resolve({
        enabled: true,
        memories: [{ id: 'mem-1', summary: 'NFS 超时根因', text: '完整结论', sessionId: 's1', agentId: 'sys-agent', agentName: '系统智能体', time: 1, promotedAt: 2 }],
        query,
      }),
    } as never)
    ctx.provide('sessionProjections', { stateOf: () => 'ops-agent' } as never)
    return { ctx, calls, registered }
  }

  it('registers schema-valid definitions for both tools (defineTool compiles schemas eagerly)', () => {
    const { ctx, registered } = toolFixture()
    applyMemoryTool(ctx)
    expect(registered.map(tool => tool.name).sort()).toEqual(['memory_recall', 'memory_record'])
  })

  it('records through the controller with the calling session context', async () => {
    const { ctx, calls, registered } = toolFixture()
    applyMemoryTool(ctx)
    const tool = registered.find(entry => entry.name === 'memory_record')
    if (tool === undefined) throw new Error('memory_record was not registered')
    const result = await tool.execute(
      { summary: '根因摘要', detail: '完整结论' },
      { agent: { session: { id: 'session-1' } } },
    )
    expect(result).toEqual({ id: 'mem-test01' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ sessionId: 'session-1', agentId: 'ops-agent', summary: '根因摘要', text: '完整结论' })
  })

  it('rejects record calls without an owning agent session', async () => {
    const { ctx, registered } = toolFixture()
    applyMemoryTool(ctx)
    const tool = registered.find(entry => entry.name === 'memory_record')
    if (tool === undefined) throw new Error('memory_record was not registered')
    await expect(tool.execute({ summary: 's', detail: 'd' }, {})).rejects.toThrow('memory_record')
  })

  it('recalls long-term memories on demand with a formatted report', async () => {
    const { ctx, registered } = toolFixture()
    applyMemoryTool(ctx)
    const tool = registered.find(entry => entry.name === 'memory_recall')
    if (tool === undefined) throw new Error('memory_recall was not registered')
    const result = await tool.execute({ query: 'NFS' }, {}) as { count: number; report: string }
    expect(result.count).toBe(1)
    expect(result.report).toContain('系统智能体')
    expect(result.report).toContain('NFS 超时根因')
  })
})
