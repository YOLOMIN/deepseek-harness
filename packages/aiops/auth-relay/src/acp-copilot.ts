/**
 * Persistent ACP client driving the Copilot agent subprocess behind the SSE chat route.
 *
 * One long-lived `dsh --profile acp` child carries every browser conversation as a
 * standard ACP session, replacing the per-message headless cold start.
 *
 * @module @gac2/dsh-aiops-auth-relay/acp-copilot
 */

import { spawn, type ChildProcess } from 'node:child_process'
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
}

/** How the relay answers the agent's tool-permission prompts. */
export type CopilotPermission = 'allow' | 'reject'

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
  /** Resolves the model credential injected into the child's environment at spawn. */
  resolveApiKey: () => Promise<string | undefined>
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
  private readonly chains = new Map<string, Promise<void>>()

  private readonly options: AcpCopilotOptions

  /**
   * @param options - spawn facts, permission policy, and credential resolver.
   * Relative paths are normalized to absolute: ACP validates session cwd as absolute.
   */
  constructor(options: AcpCopilotOptions) {
    this.options = { ...options, dshRoot: resolve(options.dshRoot), sessionCwd: resolve(options.sessionCwd) }
  }

  /**
   * Run one prompt to settlement, streaming translated updates through send.
   * A reused session id that the agent no longer knows is retried once on a fresh session.
   * @param input - browser prompt and optional conversation session id.
   * @param send - SSE frame sink; must tolerate a disconnected client.
   * @param signal - client-disconnect signal; aborting cancels the in-flight ACP prompt.
   */
  async prompt(input: CopilotPrompt, send: (frame: SseEvent) => void, signal: AbortSignal): Promise<void> {
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
    }
    send({ event: 'session', data: { sessionId: active } })
    const previous = this.chains.get(active) ?? Promise.resolve()
    const current = previous.then(() => this.runPrompt(active, message, send, signal, connection))
    const settled = current.catch(() => undefined)
    this.chains.set(active, settled)
    try {
      await current
    } finally {
      if (this.chains.get(active) === settled) this.chains.delete(active)
    }
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
    const apiKey = await this.options.resolveApiKey()
    if (apiKey !== undefined) env.DEEPSEEK_API_KEY = apiKey
    const child = (this.options.spawnChild ?? ((childEnv: NodeJS.ProcessEnv) => spawn(process.execPath, [
      '--import', pathToFileURL(join(dshRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
      join(dshRoot, 'apps/cli/src/bin.ts'),
      '--profile', 'acp', '--patch', join(dshRoot, patchPath),
    ], { cwd: this.options.sessionCwd, env: childEnv })))(env)
    const app = createAcpClientApp({ name: 'gac2-aiops-auth-relay' })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.updateSinks.get(params.sessionId)?.(params.update)
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
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
