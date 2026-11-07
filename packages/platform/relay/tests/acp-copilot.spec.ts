import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agent as createAcpAgentApp,
  methods,
  PROTOCOL_VERSION,
  type AgentConnection,
  type ClientApp,
  type ClientConnection,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'
import { AcpCopilotPool, sessionUpdateToSse, type CopilotPermission, type SseEvent } from '../src/acp-copilot.ts'

class FakeChild extends EventEmitter {
  readonly stdin = { end: vi.fn(() => { queueMicrotask(() => { this.emit('close') }) }) }
  readonly kill = vi.fn(() => { queueMicrotask(() => { this.emit('close') }) })
}

interface Harness {
  pool: AcpCopilotPool
  frames: SseEvent[]
  spawned: Array<NodeJS.ProcessEnv | undefined>
  sessionNews: string[]
  promptSessions: string[]
  cancels: string[]
  permissions: string[]
  failSessions: Set<string>
  holdUntilCancel: boolean
  children: FakeChild[]
  servers: AgentConnection[]
  clients: ClientConnection[]
}

function createHarness(options: { permission?: CopilotPermission } = {}): Harness {
  const frames: SseEvent[] = []
  const spawned: Array<NodeJS.ProcessEnv | undefined> = []
  const sessionNews: string[] = []
  const promptSessions: string[] = []
  const cancels: string[] = []
  const permissions: string[] = []
  const failSessions = new Set<string>()
  const children: FakeChild[] = []
  const servers: AgentConnection[] = []
  const clients: ClientConnection[] = []
  let holdUntilCancel = false
  const pool = new AcpCopilotPool({
    dshRoot: '/dsh',
    sessionCwd: '/work',
    patchPath: 'persona.patch.yml',
    sandboxMode: 'read-only',
    permission: options.permission ?? 'allow',
    resolveApiKey: () => Promise.resolve('test-key'),
    spawnChild: (env) => {
      spawned.push(env)
      const child = new FakeChild()
      children.push(child)
      return child as never
    },
    connect: (app: ClientApp): ClientConnection => {
      const serverRef: { current: AgentConnection | undefined } = { current: undefined }
      const server = (): AgentConnection => {
        if (serverRef.current === undefined) throw new Error('agent connection not established')
        return serverRef.current
      }
      const serverApp = createAcpAgentApp({ name: 'test-agent' })
      serverApp.onRequest(methods.agent.initialize, () => Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }))
      serverApp.onRequest(methods.agent.session.new, ({ params }) => {
        sessionNews.push(params.cwd)
        return Promise.resolve({ sessionId: `acp-${sessionNews.length}` })
      })
      serverApp.onRequest(methods.agent.session.prompt, async ({ params }) => {
        promptSessions.push(params.sessionId)
        if (failSessions.has(params.sessionId)) throw new Error('unknown session')
        if (holdUntilCancel) {
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (cancels.includes(params.sessionId)) { clearInterval(timer); resolve() }
            }, 5)
          })
          return { stopReason: 'cancelled' }
        }
        const permission = await server().client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tc-1', title: 'Shell', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
          ],
        })
        permissions.push(permission.outcome.outcome === 'selected' ? 'selected' : 'cancelled')
        const updates: SessionUpdate[] = [
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '思考中' } },
          { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Shell', kind: 'execute', status: 'in_progress' },
          { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '诊断结论' } },
          { sessionUpdate: 'usage_update', used: 10, size: 100 },
        ]
        for (const update of updates) {
          await server().client.notify(methods.client.session.update, { sessionId: params.sessionId, update })
        }
        return { stopReason: 'end_turn' }
      })
      serverApp.onNotification(methods.agent.session.cancel, ({ params }) => {
        cancels.push(params.sessionId)
      })
      serverRef.current = serverApp.connect(app)
      servers.push(serverRef.current)
      const clientConnection = app.connect(serverApp)
      clients.push(clientConnection)
      return clientConnection
    },
  })
  return {
    pool, frames, spawned, sessionNews, promptSessions, cancels, permissions,
    failSessions, children, servers, clients,
    get holdUntilCancel() { return holdUntilCancel },
    set holdUntilCancel(value: boolean) { holdUntilCancel = value },
  }
}

function sendOf(harness: Harness): (frame: SseEvent) => void {
  return frame => harness.frames.push(frame)
}

describe('sessionUpdateToSse', () => {
  it('maps the standard update variants consumed by the Copilot frontend', () => {
    const text = sessionUpdateToSse({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })
    expect(text).toEqual({ event: 'delta', data: { kind: 'text', text: 'a' } })
    const thought = sessionUpdateToSse({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } })
    expect(thought).toEqual({ event: 'delta', data: { kind: 'thinking', text: 'b' } })
    const call = sessionUpdateToSse({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'execute', status: 'in_progress' })
    expect(call).toEqual({ event: 'tool', data: { phase: 'call', name: 'Bash' } })
    const done = sessionUpdateToSse({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
    expect(done).toEqual({ event: 'tool', data: { phase: 'result', name: 't1' } })
  })

  it('ignores variants and content the frontend does not consume', () => {
    expect(sessionUpdateToSse({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })).toBeUndefined()
    expect(sessionUpdateToSse({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toBeUndefined()
    expect(sessionUpdateToSse({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })).toBeUndefined()
  })
})

describe('AcpCopilotPool', () => {
  it('spawns one child, creates a session, and streams translated frames to settlement', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: '诊断 node-032 掉线' }, sendOf(harness), ac.signal)
    expect(harness.spawned).toHaveLength(1)
    expect(harness.spawned[0]?.DEEPSEEK_API_KEY).toBe('test-key')
    expect(harness.sessionNews).toEqual([resolve('/work')])
    expect(harness.promptSessions).toEqual(['acp-1'])
    expect(harness.permissions).toEqual(['selected'])
    expect(harness.frames.map(frame => frame.event)).toEqual([
      'session', 'delta', 'tool', 'tool', 'delta', 'final',
    ])
    expect(harness.frames[0]).toEqual({ event: 'session', data: { sessionId: 'acp-1' } })
    expect(harness.frames.at(-1)).toEqual({ event: 'final', data: { text: '诊断结论' } })
  })

  it('reuses the live session for follow-up prompts on the same child', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: '第一条' }, sendOf(harness), ac.signal)
    await harness.pool.prompt({ message: '第二条', sessionId: 'acp-1' }, sendOf(harness), ac.signal)
    expect(harness.spawned).toHaveLength(1)
    expect(harness.sessionNews).toHaveLength(1)
    expect(harness.promptSessions).toEqual(['acp-1', 'acp-1'])
  })

  it('creates a fresh session for an unknown incoming session id', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: 'hi', sessionId: 'stale-9' }, sendOf(harness), ac.signal)
    expect(harness.sessionNews).toHaveLength(1)
    expect(harness.promptSessions).toEqual(['acp-1'])
  })

  it('retries once on a fresh session when a reused session fails', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: '第一条' }, sendOf(harness), ac.signal)
    harness.failSessions.add('acp-1')
    harness.frames.length = 0
    await harness.pool.prompt({ message: '重试', sessionId: 'acp-1' }, sendOf(harness), ac.signal)
    expect(harness.sessionNews).toHaveLength(2)
    expect(harness.promptSessions).toEqual(['acp-1', 'acp-1', 'acp-2'])
    const sessionFrames = harness.frames.filter(frame => frame.event === 'session')
    expect(sessionFrames.at(-1)).toEqual({ event: 'session', data: { sessionId: 'acp-2' } })
    expect(harness.frames.at(-1)?.event).toBe('final')
  })

  it('surfaces an error frame when the prompt cannot run at all', async () => {
    const harness = createHarness()
    harness.failSessions.add('acp-1')
    const ac = new AbortController()
    await harness.pool.prompt({ message: 'hi' }, sendOf(harness), ac.signal)
    expect(harness.frames.map(frame => frame.event)).toEqual(['session', 'error'])
  })

  it('cancels the in-flight prompt instead of killing the child on disconnect', async () => {
    const harness = createHarness()
    harness.holdUntilCancel = true
    const ac = new AbortController()
    const pending = harness.pool.prompt({ message: '长跑' }, sendOf(harness), ac.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    ac.abort()
    await pending
    expect(harness.cancels).toEqual(['acp-1'])
    expect(harness.frames.map(frame => frame.event)).not.toContain('final')
    expect(harness.children[0]?.kill).not.toHaveBeenCalled()
  })

  it('answers permission prompts with cancelled under the reject policy', async () => {
    const harness = createHarness({ permission: 'reject' })
    const ac = new AbortController()
    await harness.pool.prompt({ message: 'hi' }, sendOf(harness), ac.signal)
    expect(harness.permissions).toEqual(['cancelled'])
  })

  it('spawns a fresh child and session after the connection dies', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: '第一条' }, sendOf(harness), ac.signal)
    // Process exit is authoritative: the pool forgets the dead child's sessions.
    harness.children[0]?.emit('close')
    await harness.pool.prompt({ message: '第二条', sessionId: 'acp-1' }, sendOf(harness), ac.signal)
    expect(harness.spawned).toHaveLength(2)
    expect(harness.sessionNews).toHaveLength(2)
  })

  it('dispose ends the child stdin and stops the child', async () => {
    const harness = createHarness()
    const ac = new AbortController()
    await harness.pool.prompt({ message: 'hi' }, sendOf(harness), ac.signal)
    const child = harness.children[0]
    await harness.pool.dispose()
    expect(child?.stdin.end).toHaveBeenCalled()
    await harness.pool.dispose()
  })
})
