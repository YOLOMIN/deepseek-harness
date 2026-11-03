/**
 * MCP server management for the operations console: lists the Nacos MCP
 * registry through its MCP-official read surface (`/v0/servers`), and
 * connects/disconnects servers by dynamically mounting `dsh-mcp-client`
 * instances — connected servers publish their tools to agents without a
 * restart. Console-editable settings (registry origin, namespace, bearer
 * token, invocation switch) persist in `aiops-mcp-registry.json` beside the
 * DSH user root and win over the plugin Config.
 *
 * @module @gac2/dsh-aiops-mcp-controller
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { apply as applyMcpClient, inject as mcpClientInject } from '@deepseek-ai/dsh-mcp-client'
import { z as zod } from 'zod'
import type {
  AiopsMcpQuery, AiopsMcpRegisterInput, AiopsMcpServerDetail, AiopsMcpServerPage, AiopsMcpServerRow, AiopsMcpSettings,
} from './types.ts'

export type * from './types.ts'

/** Deployment choices for the MCP controller. */
export interface Config {
  /** MCP registry origin (the AI-registry adaptor port), e.g. `http://192.168.10.95:9080`. */
  registryOrigin: string
  /** Registry namespace; the deployment's servers live in `public`. */
  namespaceId: string
  /** Default bearer token for server endpoints; the console override wins. */
  authToken: string
  /** Nacos console origin for register/unregister writes. */
  consoleOrigin: string
  /** Default Nacos console account for register/unregister; the console override wins. */
  consoleUsername: string
  /** Default Nacos console password for register/unregister; the console override wins. */
  consolePassword: string
  /** Settings override file; defaults to `~/.dsh/aiops-mcp-registry.json`. */
  settingsPath: string
  /** Registry and MCP handshake request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Console login/write timeout in milliseconds; the console host runs slower under load. */
  consoleTimeoutMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  registryOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).required(),
  namespaceId: z.string().min(1).default('public'),
  authToken: z.string().default(''),
  consoleOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).default('http://192.168.10.95:8080'),
  consoleUsername: z.string().default(''),
  consolePassword: z.string().default(''),
  settingsPath: z.string().min(1).default(join(homedir(), '.dsh', 'aiops-mcp-registry.json')),
  requestTimeoutMs: z.number().min(1000).max(60_000).default(15_000),
  consoleTimeoutMs: z.number().min(5000).max(120_000).default(60_000),
})

const querySchema = zod.object({
  keyword: zod.string().trim().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(100),
})

const nameSchema = zod.object({ name: zod.string().min(1) })

/** Persisted override; the switch defaults on and console credentials default to the plugin Config. */
const settingsSchema = zod.object({
  registryOrigin: zod.string().regex(/^https?:\/\/\S+$/u, '注册中心地址必须是 http(s) URL'),
  namespaceId: zod.string().min(1),
  authToken: zod.string().default(''),
  consoleOrigin: zod.string().default(''),
  consoleUsername: zod.string().default(''),
  consolePassword: zod.string().default(''),
  autoInvoke: zod.boolean().default(true),
})

const registerSchema = zod.object({
  name: zod.string().regex(/^[A-Za-z0-9_-]{1,32}$/u, '名称仅限字母数字、-、_，≤32 字符'),
  description: zod.string().default(''),
  url: zod.string().regex(/^https?:\/\/\S+$/u, '端点必须是 http(s) URL'),
  version: zod.string().default('1.0.0'),
})

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-mcp/invalid', message, { field })
}

function upstream(status: string, message: string): RemoteError {
  return new RemoteError('aiops-mcp/upstream', message, { status })
}

/** One server entry of the MCP-official registry list envelope. */
interface RegistryServerEntry {
  readonly name?: string
  readonly description?: string
  readonly version?: string
  readonly remotes?: ReadonlyArray<{ readonly type?: string; readonly url?: string }>
}

interface RegistryServerList {
  readonly servers?: ReadonlyArray<{ readonly server?: RegistryServerEntry }>
}

/** One live connection: the mounted mcp-client fiber plus the handshake-observed tools. */
interface Connection {
  readonly fiber: Fiber
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema?: unknown }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** MCP registry + live connection owner for the operations console. */
    aiopsMcpController: AiopsMcpController
  }
}

/**
 * Host owner of the `aiopsMcp` namespace. Registry reads hit `/v0/servers`
 * on every query and page locally (the surface reports no total); connection
 * state lives in memory and resets to disconnected on restart.
 */
export class AiopsMcpController extends TypertRemoteService {
  // tools 自身不使用，但动态挂载的 mcp-client 子插件的 inject 只能经本上下文解析，
  // 必须在这里声明，子插件才看得到该服务。
  static readonly inject = ['tools']

  private readonly config: Config
  private readonly connections = new Map<string, Connection>()

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsMcpController', { namespace: 'aiopsMcp' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
    owner.effect(() => async () => {
      for (const name of [...this.connections.keys()]) await this.disconnectOne(name)
    }, 'aiops-mcp-controller: dispose connections')
  }

  /**
   * Settings currently in effect: the console-saved override file wins over
   * the plugin Config from cordis.yml.
   * @returns the merged settings with the switch defaulted on.
   */
  private async effectiveSettings(): Promise<AiopsMcpSettings> {
    let raw: string | undefined
    try {
      raw = await readFile(this.overridePath(), 'utf8')
    } catch {
      // 覆盖文件缺失或不可读时回退插件配置
    }
    if (raw !== undefined) {
      try {
        const parsed = settingsSchema.safeParse(JSON.parse(raw))
        if (parsed.success) {
          return {
            ...parsed.data,
            consoleOrigin: parsed.data.consoleOrigin === '' ? this.config.consoleOrigin : parsed.data.consoleOrigin,
            consoleUsername: parsed.data.consoleUsername === '' ? this.config.consoleUsername : parsed.data.consoleUsername,
            consolePassword: parsed.data.consolePassword === '' ? this.config.consolePassword : parsed.data.consolePassword,
          }
        }
      } catch {
        // JSON 损坏等价于无覆盖，避免阻塞清单查询
      }
    }
    return {
      registryOrigin: this.config.registryOrigin,
      namespaceId: this.config.namespaceId,
      authToken: this.config.authToken,
      consoleOrigin: this.config.consoleOrigin,
      consoleUsername: this.config.consoleUsername,
      consolePassword: this.config.consolePassword,
      autoInvoke: true,
    }
  }

  /** Path of the console-saved settings override. */
  private overridePath(): string {
    return this.config.settingsPath
  }

  /**
   * Normalize one registry remotes URL: the fork emits `null://` when the
   * endpoint protocol is unset, and the deployment serves plain HTTP.
   */
  private static normalizeUrl(url: string | undefined): string {
    if (url === undefined || url === '') return ''
    return url.replace(/^null:\/\//u, 'http://')
  }

  /** GET the registry server list (a generous single page; local paging follows). */
  private async fetchServers(): Promise<readonly RegistryServerEntry[]> {
    const settings = await this.effectiveSettings()
    // 注册表面对 limit 上限敏感（>100 返回 500 server limit match），取最大可用值后本地分页。
    const query = new URLSearchParams({ namespaceId: settings.namespaceId, limit: '100' })
    const body = await this.fetchJson(`${settings.registryOrigin}/v0/servers?${query}`, 'MCP 注册中心') as RegistryServerList
    return (body.servers ?? []).flatMap(entry => entry.server === undefined ? [] : [entry.server])
  }

  /**
   * GET JSON with one retry: the registry host runs under heavy load and
   * intermittently times out or 5xx's idempotent reads, so a single retry after
   * a short pause smooths the console without masking persistent failures.
   */
  private async fetchJson(url: string, label: string): Promise<unknown> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1500))
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
        if (response.ok) return await response.json()
        if (response.status < 500) throw upstream(String(response.status), `${label}返回 HTTP ${response.status}`)
        lastError = upstream(String(response.status), `${label}返回 HTTP ${response.status}（远端负载过高，已自动重试）`)
      } catch (error: unknown) {
        if (error instanceof RemoteError) throw error
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        lastError = upstream(
          timeout ? 'timeout' : 'unreachable',
          timeout
            ? `${label}响应超时（>${this.config.requestTimeoutMs / 1000}s，远端负载过高，已自动重试）`
            : `${label}不可达：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    throw lastError
  }

  /** Map one registry entry into the wire row. */
  private rowOf(entry: RegistryServerEntry): AiopsMcpServerRow {
    const name = entry.name ?? 'unknown'
    const remote = entry.remotes?.[0]
    const connection = this.connections.get(name)
    return {
      name,
      description: entry.description ?? '',
      version: entry.version ?? '-',
      transport: remote?.type ?? '-',
      url: AiopsMcpController.normalizeUrl(remote?.url),
      ...(connection === undefined ? {} : { toolCount: connection.tools.length }),
      connected: connection !== undefined,
    }
  }

  /**
   * Query registry servers merged with live connection state.
   * @param input - keyword filter plus paging.
   * @returns the filtered page with the connected count.
   */
  @Remote('list')
  async list(input: AiopsMcpQuery): Promise<AiopsMcpServerPage> {
    const parsed = querySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const keyword = parsed.data.keyword?.toLowerCase()
    const rows = (await this.fetchServers())
      .map(entry => this.rowOf(entry))
      .filter(row => keyword === undefined || keyword === '' || `${row.name}\n${row.description}`.toLowerCase().includes(keyword))
      .sort((a, b) => a.name.localeCompare(b.name))
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: rows.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: rows.slice(start, start + parsed.data.pageSize),
      connectedCount: rows.filter(row => row.connected).length,
    }
  }

  /**
   * Read one server's detail for the console dialog; the tool list reflects
   * the last live handshake when connected.
   * @param input - server name.
   * @returns the row beside the known tools.
   */
  @Remote('detail')
  async detail(input: { readonly name: string }): Promise<AiopsMcpServerDetail> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'MCP Server 名称无效')
    const name = parsed.data.name
    const entry = (await this.fetchServers()).find(row => row.name === name)
    if (entry === undefined) {
      throw new RemoteError('aiops-mcp/not-found', `注册中心没有该 MCP Server：${name}`, { name })
    }
    return { row: this.rowOf(entry), tools: this.connections.get(name)?.tools ?? [] }
  }

  /**
   * Connect one registry server: handshake the endpoint (initialize +
   * tools/list) with the configured bearer token, then mount an mcp-client
   * plugin so its tools become callable by agents.
   * @param input - server name.
   * @returns confirmation with the observed tool count.
   */
  @Remote('connect')
  async connect(input: { readonly name: string }): Promise<{ readonly connected: true; readonly toolCount: number }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'MCP Server 名称无效')
    const name = parsed.data.name
    const settings = await this.effectiveSettings()
    if (!settings.autoInvoke) {
      throw new RemoteError('aiops-mcp/disabled', '自动调用已停用：请先在「工具调用」开关中开启', {})
    }
    if (this.connections.has(name)) {
      return { connected: true, toolCount: this.connections.get(name)?.tools.length ?? 0 }
    }
    const entry = (await this.fetchServers()).find(row => row.name === name)
    if (entry === undefined) {
      throw new RemoteError('aiops-mcp/not-found', `注册中心没有该 MCP Server：${name}`, { name })
    }
    const url = AiopsMcpController.normalizeUrl(entry.remotes?.[0]?.url)
    if (url === '') throw invalid('url', `该 MCP Server 缺少可用端点：${name}`)
    const tools = await this.handshake(name, url, settings.authToken)
    const fiber = await this.mount(name, url, settings.authToken)
    this.connections.set(name, { fiber, tools })
    return { connected: true, toolCount: tools.length }
  }

  /**
   * Disconnect one server: dispose its mcp-client mount; the registry entry stays.
   * @param input - server name.
   * @returns confirmation of the disconnect.
   */
  @Remote('disconnect')
  async disconnect(input: { readonly name: string }): Promise<{ readonly disconnected: true }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'MCP Server 名称无效')
    await this.disconnectOne(parsed.data.name)
    return { disconnected: true }
  }

  /**
   * Register one MCP server into the Nacos registry: handshake the endpoint to
   * discover its tools, then write server/endpoint/tool specifications through
   * the console admin API.
   * @param input - name, description, endpoint URL, optional version.
   * @returns confirmation with the discovered tool count.
   */
  @Remote('register')
  async register(input: AiopsMcpRegisterInput): Promise<{ readonly registered: true; readonly toolCount: number }> {
    const parsed = registerSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `注册参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const { name, description, url, version } = parsed.data
    if ((await this.fetchServers()).some(row => row.name === name)) {
      throw invalid('name', `注册中心已存在同名 MCP Server：${name}`)
    }
    const settings = await this.effectiveSettings()
    const tools = await this.handshake(name, url, settings.authToken)
    const endpoint = new URL(url)
    const body = new URLSearchParams({
      namespaceId: settings.namespaceId,
      mcpName: name,
      serverSpecification: JSON.stringify({
        name,
        protocol: 'mcp-streamable',
        frontProtocol: 'mcp-streamable',
        description,
        versionDetail: { version },
        remoteServerConfig: { exportPath: endpoint.pathname === '' ? '/' : endpoint.pathname },
        capabilities: ['TOOL'],
        enabled: true,
      }),
      endpointSpecification: JSON.stringify({
        type: 'DIRECT',
        data: {
          address: endpoint.hostname,
          port: endpoint.port === '' ? (endpoint.protocol === 'https:' ? '443' : '80') : endpoint.port,
          protocol: endpoint.protocol.replace(':', ''),
        },
      }),
      toolSpecification: JSON.stringify({
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      }),
    })
    await this.consoleWrite(settings, 'POST', '/v3/console/ai/mcp', body, name)
    return { registered: true, toolCount: tools.length }
  }

  /**
   * Unregister one MCP server from the Nacos registry; a live connection here
   * is disposed first. The local tools disappear with the registry entry.
   * @param input - server name.
   * @returns confirmation of the removal.
   */
  @Remote('unregister')
  async unregister(input: { readonly name: string }): Promise<{ readonly unregistered: true }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'MCP Server 名称无效')
    const name = parsed.data.name
    const settings = await this.effectiveSettings()
    const body = new URLSearchParams({ namespaceId: settings.namespaceId, mcpName: name })
    await this.consoleWrite(settings, 'DELETE', '/v3/console/ai/mcp', body, name)
    await this.disconnectOne(name)
    return { unregistered: true }
  }

  /** Nacos console access token, cached for 30 minutes per settings change. */
  private consoleTokenCache: { token: string; expiresAt: number } | undefined

  /** One console admin write (POST/PUT/DELETE) with a cached login token. */
  private async consoleWrite(settings: AiopsMcpSettings, method: string, path: string, body: URLSearchParams, name: string): Promise<void> {
    if (settings.consoleUsername === '' || settings.consolePassword === '') {
      throw invalid('console', '未配置 Nacos 控制台账号：请在「注册中心配置」中填写控制台账号与密码')
    }
    const token = await this.consoleToken(settings)
    let response: Response
    try {
      response = await fetch(`${settings.consoleOrigin}${path}?accessToken=${encodeURIComponent(token)}`, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.config.consoleTimeoutMs),
      })
    } catch (error: unknown) {
      throw new RemoteError('aiops-mcp/register', `控制台写入不可达：${error instanceof Error ? error.message : String(error)}`, { name })
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200)
      throw new RemoteError('aiops-mcp/register', `控制台写入失败：HTTP ${response.status} ${text}`, { name })
    }
    const result = await response.json() as { code?: number; message?: string }
    if (result.code !== undefined && result.code !== 0) {
      throw new RemoteError('aiops-mcp/register', `控制台写入被拒：${result.message ?? 'unknown'}`, { name })
    }
  }

  /** Login to the Nacos console once per 30 minutes and reuse the access token. */
  private async consoleToken(settings: AiopsMcpSettings): Promise<string> {
    if (this.consoleTokenCache !== undefined && Date.now() < this.consoleTokenCache.expiresAt) {
      return this.consoleTokenCache.token
    }
    let response: Response
    try {
      response = await fetch(`${settings.consoleOrigin}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: settings.consoleUsername, password: settings.consolePassword }),
        signal: AbortSignal.timeout(this.config.consoleTimeoutMs),
      })
    } catch (error: unknown) {
      throw new RemoteError('aiops-mcp/register', `控制台登录不可达：${error instanceof Error ? error.message : String(error)}`, { name: '-' })
    }
    if (!response.ok) {
      throw new RemoteError('aiops-mcp/register', `控制台登录失败：HTTP ${response.status}（请检查控制台账号密码）`, { name: '-' })
    }
    const body = await response.json() as { accessToken?: string }
    if (body.accessToken === undefined) {
      throw new RemoteError('aiops-mcp/register', '控制台登录响应缺少 accessToken', { name: '-' })
    }
    this.consoleTokenCache = { token: body.accessToken, expiresAt: Date.now() + 30 * 60_000 }
    return body.accessToken
  }

  /**
   * Read the settings the console shows and the operations use.
   * @returns the effective registry connection, token presence, and the switch.
   */
  @Remote('getSettings')
  async getSettings(): Promise<AiopsMcpSettings> {
    return this.effectiveSettings()
  }

  /**
   * Persist the settings override; later operations read it. Switching
   * invocation off disconnects every live server immediately.
   * @param input - full settings (every field required).
   * @returns the persisted settings.
   */
  @Remote('saveSettings')
  async saveSettings(input: AiopsMcpSettings): Promise<AiopsMcpSettings> {
    const parsed = settingsSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `MCP 配置无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const previous = await this.effectiveSettings()
    await mkdir(dirname(this.overridePath()), { recursive: true })
    await writeFile(this.overridePath(), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
    if (previous.autoInvoke && !parsed.data.autoInvoke) {
      for (const name of [...this.connections.keys()]) await this.disconnectOne(name)
    }
    return parsed.data
  }

  /** Dispose one live connection, tolerating an already-absent entry. */
  private async disconnectOne(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (connection === undefined) return
    this.connections.delete(name)
    await connection.fiber.dispose()
  }

  /** MCP streamable-http handshake: initialize, then tools/list; returns the observed tools. */
  private async handshake(name: string, url: string, token: string): Promise<Connection['tools']> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
    }
    const post = async (body: unknown, sessionId?: string): Promise<Response> => {
      try {
        return await fetch(url, {
          method: 'POST',
          headers: sessionId === undefined ? headers : { ...headers, 'Mcp-Session-Id': sessionId },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        })
      } catch (error: unknown) {
        throw new RemoteError('aiops-mcp/connect', `端点不可达：${error instanceof Error ? error.message : String(error)}`, { name })
      }
    }
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'aiops-console', version: '0.1' } },
    })
    if (!init.ok) {
      throw new RemoteError('aiops-mcp/connect', `握手失败：HTTP ${init.status}（请检查对接 Token）`, { name })
    }
    const sessionId = init.headers.get('mcp-session-id') ?? undefined
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
    const listResponse = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
    if (!listResponse.ok) {
      throw new RemoteError('aiops-mcp/connect', `tools/list 失败：HTTP ${listResponse.status}`, { name })
    }
    const payload = await listResponse.json() as {
      result?: { tools?: ReadonlyArray<{ name?: string; description?: string; inputSchema?: unknown }> }
    }
    return (payload.result?.tools ?? []).flatMap(tool =>
      tool.name === undefined
        ? []
        : [{
          name: tool.name,
          description: tool.description ?? '',
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }])
  }

  /** Mount one mcp-client plugin instance for the server; returns its fiber handle. */
  private async mount(name: string, url: string, token: string): Promise<Fiber> {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
      throw invalid('name', `MCP Server 名称不满足工具命名空间约束（[A-Za-z0-9_-]，≤32 字符）：${name}`)
    }
    // 动态挂载必须显式携带 inject：ctx.plugin 只认插件对象自身的 inject 声明，
    // 模块级 export 在这里不会被合并。
    const fiber = this.ctx.plugin({
      name: 'mcp-client',
      inject: mcpClientInject,
      apply: applyMcpClient,
    }, {
      transport: 'streamable-http' as const,
      serverName: name,
      url,
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: true,
    })
    try {
      await fiber
    } catch (error: unknown) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
      const detail = [error instanceof Error ? error.message : String(error), cause?.message].filter(Boolean).join('；原因：')
      throw new RemoteError('aiops-mcp/connect', `挂载失败：${detail}`, { name }, { cause: error })
    }
    return fiber
  }
}

export default AiopsMcpController
