import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { Context } from '@deepseek-ai/cordis'
import AiopsLogController from '../src/index.ts'
import { sessionToLogRows } from '../src/projection.ts'

function headerOf(id: string, agentPreset?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

function eventsOf(specs: Array<SessionEvent['type']>): SessionEvent[] {
  return specs.map((type, index) => {
    const base = { type, seq: index + 1, time: 1000 + index * 1000, ignorable: true }
    switch (type) {
      case 'turn/start':
        return { ...base, data: { turn: 1 } } as SessionEvent
      case 'user/message':
        return ({ ...base, data: { message: { id: 'u1', content: [], source: { kind: 'test' } } } }) as never
      case 'tool/call':
        return { ...base, data: { turn: 1, step: 1, callId: 'c1', name: 'metric-query', arguments: '{}' } } as never
      case 'assistant/message':
        return {
          ...base,
          data: {
            turn: 1, step: 1,
            message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '根因是 ToR 端口误码率过高' }] },
            stream: [],
          },
        } as never
      case 'tool/result':
        return {
          ...base,
          data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [], source: { kind: 'test' } } },
        } as never
      case 'turn/end':
        return { ...base, data: { turn: 1, reason: { kind: 'completed' } } } as never
      case 'agent-preset/selected':
        return { ...base, data: { agentPreset: 'ops-agent' } } as never
      default:
        throw new Error(`fixture does not model ${type}`)
    }
  })
}

function queryFixture(sessions: Array<{ id: string; preset?: string; events: SessionEvent[] }>) {
  const ctx = new Context()
  ctx.provide('aiopsAgentController', { managedPresetIds: () => Promise.resolve(['ops-agent']) } as never)
  ctx.provide('agentPresets', {
    list: () => Promise.resolve([
      { id: 'ops-agent', name: '运维智能体' },
      { id: 'sys-agent', name: '系统智能体' },
    ]),
  } as never)
  const records: SessionRecord[] = sessions.map(session => ({
    header: headerOf(session.id, session.preset),
    live: false,
    persisted: true,
  }))
  ctx.provide('sessionQuery', {
    listSessions: () => Promise.resolve(records),
    readSession: (sessionId: SessionId) => {
      const found = sessions.find(session => SessionId(session.id) === sessionId)
      if (found === undefined) return Promise.reject(new Error('unknown session'))
      const snapshot: SessionLogSnapshot = {
        session: headerOf(found.id, found.preset),
        inheritedEventCount: 0 as never,
        events: found.events,
      }
      return Promise.resolve(snapshot)
    },
  } as never)
  const controller = new AiopsLogController(ctx)
  return { ctx, controller }
}

describe('sessionToLogRows', () => {
  it('projects turn boundaries, model output, and tool results with call pairing', () => {
    const events = eventsOf(['turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'])
    const rows = sessionToLogRows('s1', events)
    expect(rows.map(entry => entry.row.kind)).toEqual(['run', 'model', 'tool', 'decision'])
    expect(rows[2]?.row.summary).toBe('工具 metric-query 调用完成')
    expect(rows[1]?.row.summary).toContain('根因是 ToR 端口误码率过高')
    expect(rows[1]?.search).toContain('根因是 ToR 端口误码率过高')
  })

  it('matches keywords against the full untruncated text, not the excerpt', () => {
    const longText = `${'前言 '.repeat(40)}误码率超标`
    const events = eventsOf(['assistant/message'])
    const message = events[0]
    if (message === undefined) throw new Error('fixture expects an assistant/message event')
    ;(message.data as { message: { content: { type: string; text: string }[] } }).message.content = [{ type: 'text', text: longText }]
    const rows = sessionToLogRows('s1', events)
    expect(rows[0]?.row.summary).not.toContain('误码率超标')
    expect(rows[0]?.search).toContain('误码率超标')
  })

  it('marks failed tool results and interrupted model output as warnings', () => {
    const failed = eventsOf(['tool/call', 'tool/result'])
    const result = failed[1]
    if (result === undefined) throw new Error('fixture expects a tool/result event')
    ;(result.data as { message: { isError?: boolean } }).message.isError = true
    const rows = sessionToLogRows('s1', failed)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.row).toMatchObject({ level: 'warn', kind: 'tool' })
    expect(rows[0]?.row.summary).toContain('失败')
  })
})

describe('AiopsLogController.query', () => {
  const base = { page: 1, pageSize: 50 }

  it('projects rows only from managed and inner presets, newest first', async () => {
    const { controller } = queryFixture([
      { id: 's-ops', preset: 'ops-agent', events: eventsOf(['turn/start', 'assistant/message', 'turn/end']) },
      { id: 's-inner', preset: 'sys-agent', events: eventsOf(['turn/start']) },
      { id: 's-other', preset: 'standard', events: eventsOf(['turn/start']) },
      { id: 's-none', events: eventsOf(['turn/start']) },
    ])
    const page = await controller.query(base)
    expect(page.total).toBe(4)
    expect(page.rows.map(row => row.sessionId).sort()).toEqual(['s-inner', 's-ops', 's-ops', 's-ops'])
    expect(page.rows.find(row => row.sessionId === 's-inner')?.agent).toBe('系统智能体')
    expect(page.rows.find(row => row.sessionId === 's-ops')?.agent).toBe('运维智能体')
  })

  it('adopts the agent preset recorded by the session events when the header has none', async () => {
    const { controller } = queryFixture([
      { id: 's-late', events: eventsOf(['turn/start', 'agent-preset/selected', 'turn/end']) },
    ])
    const page = await controller.query(base)
    expect(page.total).toBe(2)
    expect(page.rows.every(row => row.agent === '运维智能体')).toBe(true)
  })

  it('filters by keyword, kind, and time bound', async () => {
    const { controller } = queryFixture([
      { id: 's-ops', preset: 'ops-agent', events: eventsOf(['turn/start', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']) },
    ])
    const byKeyword = await controller.query({ ...base, keyword: '误码' })
    expect(byKeyword.rows.map(row => row.kind)).toEqual(['model'])
    const byKind = await controller.query({ ...base, kind: 'tool' })
    expect(byKind.rows.map(row => row.summary)).toEqual(['工具 metric-query 调用完成'])
    const byTime = await controller.query({ ...base, fromMs: 3500 })
    expect(byTime.rows.every(row => row.time >= 3500)).toBe(true)
    expect(byTime.total).toBe(2)
    const byRange = await controller.query({ ...base, fromMs: 1500, toMs: 3500 })
    expect(byRange.rows.every(row => row.time >= 1500 && row.time <= 3500)).toBe(true)
    // 区间内只有 assistant/message（t=2000）；tool/call 不投影为日志行
    expect(byRange.total).toBe(1)
    expect(byRange.rows[0]?.agent).toBe('运维智能体')
  })

  it('pages the filtered rows', async () => {
    const { controller } = queryFixture([
      { id: 's-ops', preset: 'ops-agent', events: eventsOf(['turn/start', 'assistant/message', 'turn/end']) },
    ])
    const first = await controller.query({ page: 1, pageSize: 2 })
    expect(first.total).toBe(3)
    expect(first.rows).toHaveLength(2)
    const second = await controller.query({ page: 2, pageSize: 2 })
    expect(second.rows).toHaveLength(1)
    expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id)
  })

  it('rejects malformed queries at the wire boundary', async () => {
    const { controller } = queryFixture([])
    await expect(controller.query({ page: 0, pageSize: 50 })).rejects.toMatchObject({ code: 'aiops-logs/invalid' })
    await expect(controller.query({ page: 1, pageSize: 500 })).rejects.toMatchObject({ code: 'aiops-logs/invalid' })
  })

  it('returns one row with its full event payload for detail and export', async () => {
    const events = eventsOf(['turn/start', 'tool/call', 'tool/result', 'turn/end'])
    const { controller } = queryFixture([{ id: 's-ops', preset: 'ops-agent', events }])
    const detail = await controller.detail({ sessionId: 's-ops', seq: 3 })
    expect(detail.row).toMatchObject({ kind: 'tool', summary: '工具 metric-query 调用完成' })
    expect(detail.eventType).toBe('tool/result')
    expect(detail.data).toMatchObject({ turn: 1, step: 1 })
  })

  it('rejects detail reads for unknown seq or non-projected events', async () => {
    const events = eventsOf(['turn/start', 'tool/call'])
    const { controller } = queryFixture([{ id: 's-ops', preset: 'ops-agent', events }])
    await expect(controller.detail({ sessionId: 's-ops', seq: 99 })).rejects.toMatchObject({ code: 'aiops-logs/invalid' })
    // tool/call 不投影为日志行
    await expect(controller.detail({ sessionId: 's-ops', seq: 2 })).rejects.toMatchObject({ code: 'aiops-logs/invalid' })
  })
})
