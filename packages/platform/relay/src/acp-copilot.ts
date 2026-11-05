/**
 * Persistent ACP client driving the Copilot agent subprocess behind the SSE chat route.
 *
 * One long-lived `dsh --profile acp` child carries every browser conversation as a
 * standard ACP session, replacing the per-message headless cold start.
 *
 * @module @gac2/dsh-platform-relay/acp-copilot
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk'

/** One SSE frame accepted by the operations platform Copilot frontend. */
export interface SseEvent {
  /** SSE event name: session, delta, tool, status, final, or error. */
  event: string
  /** JSON-serializable frame payload. */
  data: Record<string, unknown>
}

/** One browser Copilot prompt accepted by the relay. */
export interface CopilotPrompt {
  /** User message text. */
  message: string
  /** ACP session id returned by an earlier `session` frame, for conversation continuity. */
  sessionId?: string
  /**
   * Per-message sandbox override: switching modes respawns the ACP child
   * (refused while a turn is in flight). Omit to keep the current mode.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

/** How the relay answers the agent's tool-permission prompts. */
export type CopilotPermission = 'allow' | 'reject' | 'ask'

/** How long a held permission prompt waits for the human answer before cancelling it. */
const PERMISSION_TIMEOUT_MS = 120_000

/** One permission prompt held for a human decision through the relay route. */
interface PendingPermission {
  readonly resolve: (outcome: RequestPermissionResponse) => void
  readonly timer: NodeJS.Timeout
  /** Option to select when the human allows; undefined when the agent offered no allow choice. */
  readonly allowOptionId: string | undefined
}

/** Process and deployment facts the pool needs to spawn and drive the ACP child. */
export interface AcpCopilotOptions {
  /** DSH repository or installation root used to locate the CLI entry and patch. */
  dshRoot: string
  /** Workspace shared by ACP Copilot sessions and Web Sessions. */
  sessionCwd: string
  /** Persona/identity patch applied to the acp profile, resolved against {@link dshRoot}. */
  patchPath: string
  /** Auto-answer policy for the agent's permission prompts. */
  permission: CopilotPermission
  /**
   * Sandbox mode injected into the ACP child (`DSH_PERMISSION_MODE`):
   * `read-only` 让写操作一律走沙箱升级审批（配合 permission: ask 形成人工确认）；
   * `workspace-write`/`danger-full-access` 逐级放宽。
   */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Resolves the model credential injected into the child's environment at spawn. */
  resolveApiKey: () => Promise<string | undefined>
  /**
   * Called once per completed prompt with the assembled answer; its return
   * value is forwarded as an extra `solution` SSE frame (failures must be
   * contained inside the hook — they never reject the prompt).
   */
  onFinal?: (input: {
    readonly sessionId: string
    readonly message: string
    readonly text: string
  }) => Promise<Record<string, unknown> | undefined>
  /** Test hook replacing the stdio connection factory, e.g. an in-process agent app. */
  connect?: (app: ClientApp, child: ChildProcess) => ClientConnection
  /** Test hook replacing the child-process spawn. */
  spawnChild?: (env: NodeJS.ProcessEnv) => ChildProcess
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Text carried by one ACP content block, or undefined for non-text blocks. */
function contentText(content: unknown): string | undefined {
  const block = recordOf(content)
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/**
 * Translate one standard ACP session update into the Copilot SSE contract.
 * @param update - update received over the ACP connection.
 * @returns the frame to forward, or undefined for updates the frontend does not consume.
 */
export function sessionUpdateToSse(update: SessionUpdate): SseEvent | undefined {
  // ACP session updates are merge-extensible upstream; unknown variants are ignored.
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      return text === undefined ? undefined : { event: 'delta', data: { kind: 'text', text } }
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      return text === undefined ? undefined : { event: 'delta', data: { kind: 'thinking', text } }
    }
    case 'tool_call':
      return { event: 'tool', data: { phase: 'call', name: update.title } }
    case 'tool_call_update':
      return update.status === 'completed' || update.status === 'failed'
        ? { event: 'tool', data: { phase: 'result', name: update.toolCallId } }
        : undefined
    default:
      return undefined
  }
}

function sessionIdOf(response: unknown): string {
  const id = recordOf(response)?.sessionId
  if (typeof id !== 'string' || id === '') throw new Error('ACP 会话创建未返回 sessionId')
  return id
}

/**
 * Connect the client app over the child's stdio pipes.
 * @param clientApp - relay client application with update and permission handlers.
 * @param child - spawned ACP server process with piped stdio.
 * @returns the live client-side protocol connection.
 */
function connectStdio(clientApp: ClientApp, child: ChildProcess): ClientConnection {
  if (child.stdin === null || child.stdout === null) throw new Error('ACP 子进程缺少 stdio 管道')
  return clientApp.connect(ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
}

/** One tracked Copilot conversation for the history list. */
export interface CopilotSessionInfo {
  readonly id: string
  /** First user message, truncated for display. */
  readonly title: string
  readonly createdAt: number
  readonly lastActiveAt: number
}

/**
 * Owns the ACP Copilot subprocess and routes prompts to per-conversation sessions.
 * Sessions live inside the child; a child crash drops the session set and the next
 * prompt spawns a fresh child, so browser retries always land on a live agent.
 */
export class AcpCopilotPool {
  private child: ChildProcess | undefined
  private connection: ClientConnection | undefined
  private starting: Promise<ClientConnection> | undefined
  private readonly liveSessions = new Set<string>()
  private readonly updateSinks = new Map<string, (update: SessionUpdate) => void>()
  /** Per-session out-of-band SSE sinks (permission prompts are requests, not session updates). */
  private readonly eventSinks = new Map<string, (frame: SseEvent) => void>()
  private readonly chains = new Map<string, Promise<void>>()
  /** Permission prompts awaiting a human answer, keyed by relay-issued request id. */
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  /** Conversation ledger for the history endpoint, keyed by session id. */
  private readonly sessionInfos = new Map<string, CopilotSessionInfo>()
  /** The sandbox mode the current child was spawned with. */
  private spawnedMode: string

  private readonly options: AcpCopilotOptions

  /**
   * @param options - spawn facts, permission policy, and credential resolver.
   * Relative paths are normalized to absolute: ACP validates session cwd as absolute.
   */
  constructor(options: AcpCopilotOptions) {
    this.options = { ...options, dshRoot: resolve(options.dshRoot), sessionCwd: resolve(options.sessionCwd) }
    this.spawnedMode = options.sandboxMode
  }

  /** Conversation ledger for the history list, most recently active first. */
  sessions(): CopilotSessionInfo[] {
    return [...this.sessionInfos.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** The sandbox mode the current child enforces (respawned mode or the configured default). */
  currentMode(): string {
    return this.spawnedMode
  }

  /**
   * Switch the Copilot sandbox mode by respawning the child with the new
   * `DSH_PERMISSION_MODE`. Sessions are child-scoped and do not survive the
   * respawn; refuse while any prompt is in flight so a running turn is never
   * killed by a mode flip.
   * @returns true when the child was respawned with the new mode.
   */
  async setMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<boolean> {
    if (mode === this.spawnedMode) return false
    if (this.chains.size > 0) return false
    this.options.sandboxMode = mode
    this.spawnedMode = mode
    this.liveSessions.clear()
    this.sessionInfos.clear()
    await this.dispose()
    return true
  }

  /**
   * Cancel the running turn of one session (ACP session/cancel).
   * @returns false when no live connection/session exists.
   */
  async cancelSession(sessionId: string): Promise<boolean> {
    if (this.connection === undefined || !this.liveSessions.has(sessionId)) return false
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId })
    return true
  }

  /**
   * Run one prompt to settlement, streaming translated updates through send.
   * A reused session id that the agent no longer knows is retried once on a fresh session.
   * @param input - browser prompt and optional conversation session id.
   * @param send - SSE frame sink; must tolerate a disconnected client.
   * @param signal - client-disconnect signal; aborting cancels the in-flight ACP prompt.
   */
  async prompt(input: CopilotPrompt, send: (frame: SseEvent) => void, signal: AbortSignal): Promise<void> {
    // 每条消息可携带沙箱档位：与当前子进程档位不同则热重建（会话上下文随旧子进程结束）
    if (input.sandboxMode !== undefined) {
      const switched = await this.setMode(input.sandboxMode)
      if (switched) send({ event: 'status', data: { message: `沙箱档位已切换为 ${input.sandboxMode}（智能体上下文已重置）` } })
    }
    const reused = input.sessionId !== undefined && this.liveSessions.has(input.sessionId)
      ? input.sessionId
      : undefined
    try {
      await this.runOnSession(input.message, send, signal, reused)
    } catch (error: unknown) {
      if (reused === undefined || signal.aborted) {
        send({ event: 'error', data: { message: error instanceof Error ? error.message : String(error) } })
        return
      }
      // The child restarted between requests and forgot the conversation; fall back to a fresh session once.
      try {
        await this.runOnSession(input.message, send, signal, undefined)
      } catch (retryError: unknown) {
        send({ event: 'error', data: { message: retryError instanceof Error ? retryError.message : String(retryError) } })
      }
    }
  }

  /** Stop the child and forget every session; in-flight prompts reject through the closed connection. */
  async dispose(): Promise<void> {
    // 未决权限请求一并取消，避免智能体在拆除后仍等人工答复
    for (const [, pending] of this.pendingPermissions) {
      clearTimeout(pending.timer)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingPermissions.clear()
    const child = this.child
    this.connection = undefined
    this.child = undefined
    this.starting = undefined
    this.liveSessions.clear()
    this.updateSinks.clear()
    if (child === undefined) return
    child.stdin?.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill() }, 2_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.once('error', () => { clearTimeout(timer); resolve() })
    })
  }

  private async runOnSession(
    message: string,
    send: (frame: SseEvent) => void,
    signal: AbortSignal,
    sessionId: string | undefined,
  ): Promise<void> {
    const connection = await this.ensureConnection()
    const agent = connection.agent
    let active = sessionId
    if (active === undefined) {
      active = sessionIdOf(await agent.request(methods.agent.session.new, { cwd: this.options.sessionCwd, mcpServers: [] }))
      this.liveSessions.add(active)
      // 新会话登记台账：标题取首条用户消息（截断），供历史会话列表展示
      this.sessionInfos.set(active, {
        id: active,
        title: message.replace(/\s+/g, ' ').trim().slice(0, 60),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
    } else {
      const info = this.sessionInfos.get(active)
      if (info !== undefined) this.sessionInfos.set(active, { ...info, lastActiveAt: Date.now() })
    }
    send({ event: 'session', data: { sessionId: active } })
    // 旁路事件槽随本条提示注册/回收，权限请求只投递给发起它的浏览器连接
    this.eventSinks.set(active, send)
    const previous = this.chains.get(active) ?? Promise.resolve()
    const current = previous.then(() => this.runPrompt(active, message, send, signal, connection))
    const settled = current.catch(() => undefined)
    this.chains.set(active, settled)
    try {
      await current
    } finally {
      if (this.chains.get(active) === settled) this.chains.delete(active)
      if (this.eventSinks.get(active) === send) this.eventSinks.delete(active)
      // 浏览器断开时挂起的权限请求兜底取消，避免智能体永远等待
      for (const [requestId, pending] of this.pendingPermissions) {
        if (signal.aborted) {
          this.pendingPermissions.delete(requestId)
          clearTimeout(pending.timer)
          pending.resolve({ outcome: { outcome: 'cancelled' } })
        }
      }
    }
  }

  /**
   * Hold one permission prompt until a human answers through the relay route,
   * the browser disconnects, or the timeout cancels it. Emits a `permission`
   * SSE frame carrying the request id and the tool-call summary.
   */
  private askPermission(sessionId: string, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = randomUUID()
    const toolCall = params.toolCall
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId)
        resolve({ outcome: { outcome: 'cancelled' } })
      }, PERMISSION_TIMEOUT_MS)
      this.pendingPermissions.set(requestId, {
        resolve,
        timer,
        allowOptionId: params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')?.optionId,
      })
      this.eventSinks.get(sessionId)?.({
        event: 'permission',
        data: {
          requestId,
          tool: typeof toolCall.title === 'string' ? toolCall.title : '工具调用',
          kind: typeof toolCall.kind === 'string' ? toolCall.kind : '',
          ...(toolCall.rawInput === undefined ? {} : { input: JSON.stringify(toolCall.rawInput).slice(0, 2000) }),
          options: params.options.map(option => ({ id: option.optionId, label: option.name })),
        },
      })
    })
  }

  /**
   * Answer one held permission prompt: `allow` selects the agent's allow-once
   * option captured at hold time, otherwise the prompt is cancelled. Returns
   * false when the request id is unknown or already settled.
   */
  respondPermission(requestId: string, allow: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (pending === undefined) return false
    this.pendingPermissions.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(allow && pending.allowOptionId !== undefined
      ? { outcome: { outcome: 'selected', optionId: pending.allowOptionId } }
      : { outcome: { outcome: 'cancelled' } })
    return true
  }

  private async runPrompt(
    sessionId: string,
    message: string,
    send: (frame: SseEvent) => void,
    signal: AbortSignal,
    connection: ClientConnection,
  ): Promise<void> {
    const agent = connection.agent
    let text = ''
    this.updateSinks.set(sessionId, (update) => {
      const frame = sessionUpdateToSse(update)
      if (frame === undefined) return
      if (frame.event === 'delta' && frame.data.kind === 'text' && typeof frame.data.text === 'string') {
        text += frame.data.text
      }
      send(frame)
    })
    const onAbort = (): void => {
      void agent.notify(methods.agent.session.cancel, { sessionId })
        .catch((cancelError: unknown) => { void cancelError /* the connection is already gone */ })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: message }],
      })
      if (!signal.aborted && this.options.onFinal !== undefined) {
        try {
          const extra = await this.options.onFinal({ sessionId, message, text })
          if (extra !== undefined) send({ event: 'solution', data: extra })
        } catch {
          // 方案推送失败不影响诊断答复本身
        }
      }
      if (!signal.aborted) send({ event: 'final', data: { text } })
    } finally {
      this.updateSinks.delete(sessionId)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async ensureConnection(): Promise<ClientConnection> {
    const existing = this.connection
    if (existing !== undefined && !existing.signal.aborted) return existing
    this.starting ??= this.start()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async start(): Promise<ClientConnection> {
    const { dshRoot, patchPath } = this.options
    const env: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.base.json') }
    // 沙箱模式注入子进程：read-only 下写操作触发沙箱升级审批（经 ask 策略转成人工确认）
    env.DSH_PERMISSION_MODE = this.options.sandboxMode
    const apiKey = await this.options.resolveApiKey()
    if (apiKey !== undefined) env.DEEPSEEK_API_KEY = apiKey
    const child = (this.options.spawnChild ?? ((childEnv: NodeJS.ProcessEnv) => spawn(process.execPath, [
      '--import', pathToFileURL(join(dshRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
      join(dshRoot, 'apps/cli/src/bin.ts'),
      '--profile', 'acp', '--patch', join(dshRoot, patchPath),
    ], { cwd: this.options.sessionCwd, env: childEnv })))(env)
    const app = createAcpClientApp({ name: 'gac2-platform-relay' })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.updateSinks.get(params.sessionId)?.(params.update)
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        // ask 策略：挂起请求，转成 permission SSE 事件推到 Copilot 面板，由人工点选后回填
        if (this.options.permission === 'ask') return this.askPermission(params.sessionId, params)
        if (this.options.permission === 'allow') {
          const allow = params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always')
          if (allow !== undefined) return { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
        }
        return { outcome: { outcome: 'cancelled' as const } }
      })
    const connection = (this.options.connect ?? connectStdio)(app, child)
    connection.closed.catch((closeError: unknown) => { void closeError /* teardown observes the child, not the stream */ })
      .finally(() => {
        if (this.connection !== connection) return
        this.connection = undefined
        this.child = undefined
        this.liveSessions.clear()
        this.updateSinks.clear()
      })
    this.child = child
    this.connection = connection
    child.once('close', () => {
      // Process exit is authoritative even if the protocol stream lingers.
      if (this.child !== child) return
      this.connection = undefined
      this.child = undefined
      this.liveSessions.clear()
      this.updateSinks.clear()
    })
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    return connection
  }
}
