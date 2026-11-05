/** Operations console entry and Copilot routes for GAC2 AIOps. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { AcpCopilotPool, type CopilotPermission, type SseEvent } from './acp-copilot.ts'

/** Deployment choices for the platform integration routes. */
export interface Config {
  /** Base origin of the integrated platform, used by the health probe. Required per deployment. */
  platformOrigin: string
  /** Platform health endpoint path, appended to platformOrigin. */
  healthPath: string
  /** Platform solutions endpoint path receiving pushed plans, appended to platformOrigin. */
  solutionsPath: string
  /** Cookie carrying the platform's one-time ticket through the console redirect. */
  ticketCookieName: string
  /** Cookie carrying the target tab through the console redirect. */
  tabCookieName: string
  /** DSH repository or installation root used to launch the ACP Copilot child. */
  dshRoot: string
  /** Workspace shared by ACP Copilot sessions and Web Sessions. */
  sessionCwd: string
  /** Clean console URL that the entry redirect carries the process token to. */
  consoleTarget: string
  /** Persona/identity patch applied to the acp profile, resolved against dshRoot. */
  acpPatchPath: string
  /** Auto-answer policy for the Copilot agent's tool-permission prompts: ask 转成人工确认事件。 */
  permission: CopilotPermission
  /** Copilot 会话的沙箱模式：read-only 时写操作需人工确认后沙箱升级执行。 */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Bearer token for the platform solutions API; empty disables the solution push. */
  platformBearerToken: string
  /** Solution push deadline in milliseconds; the platform host answers slowly under load. */
  solutionPushTimeoutMs: number
  /** Upstream health-check deadline in milliseconds. */
  requestTimeoutMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  platformOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u),
  healthPath: z.string().min(1).default('/api/aiops/health'),
  solutionsPath: z.string().min(1).default('/api/aiops/solutions'),
  ticketCookieName: z.string().min(1).default('pf_ticket'),
  tabCookieName: z.string().min(1).default('pf_tab'),
  dshRoot: z.string().min(1).default(process.cwd()),
  sessionCwd: z.string().min(1).default(process.cwd()),
  consoleTarget: z.string().pattern(/^https?:\/\/[^\s]+$/u).default('http://127.0.0.1:3080/'),
  acpPatchPath: z.string().min(1).default('aiops-headless.patch.yml'),
  permission: z.union(['allow', 'reject', 'ask']).default('allow'),
  sandboxMode: z.union(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  platformBearerToken: z.string().default(''),
  solutionPushTimeoutMs: z.number().min(1000).max(120_000).default(60_000),
  requestTimeoutMs: z.number().min(1).max(120_000).default(3_000),
})

const MAX_BODY_BYTES = 64 * 1024

/** Services required by the integration routes. */
export const inject = ['webServer', 'credentials', 'connection']

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(value)
}

/** One machine-actionable command extracted from the plan's exec_actions block. */
interface ExecAction {
  readonly node: string
  readonly cmd: string
  readonly reason?: string
}

/**
 * Extract the exec_actions JSON block the Copilot persona appends to a plan.
 * Accepts a fenced ```json block holding either a bare action array or an
 * object with an `exec_actions` array; invalid entries are dropped, the list
 * is capped at 20, and a missing block yields an empty list (plan-only push).
 */
export function parseExecActions(text: string): ExecAction[] {
  // 围栏首行允许带 exec_actions 标记（persona 规约的 ```json exec_actions 形式）
  const blocks = text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)
  for (const match of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1] ?? '')
    } catch {
      continue
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { exec_actions?: unknown }).exec_actions)
        ? (parsed as { exec_actions: unknown[] }).exec_actions
        : undefined
    if (list === undefined) continue
    return list.flatMap((entry): ExecAction[] => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
      const record = entry as { node?: unknown; cmd?: unknown; reason?: unknown }
      if (typeof record.node !== 'string' || record.node.trim() === '') return []
      if (typeof record.cmd !== 'string' || record.cmd.trim() === '') return []
      return [{
        node: record.node.trim(),
        cmd: record.cmd.trim(),
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      }]
    }).slice(0, 20)
  }
  return []
}

/** Plan title: first markdown heading, else the question's first 40 chars. */
function titleOf(question: string, plan: string): string {
  const heading = /^#\s+(.+)$/m.exec(plan)?.[1]?.trim()
  if (heading !== undefined && heading !== '') return heading.slice(0, 120)
  return question.replace(/\s+/g, ' ').trim().slice(0, 40)
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求必须为 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * Mount the platform integration routes on an isolated webServer.
 *
 * 本中继是任意平台对接 DSH 的通用入口：平台侧按标准契约提供认证与健康接口
 * （login/ticket/ticket-login/health，路径可由 healthPath 配置），本中继只保留
 * 控制端自身能力：
 *   - /console：控制台跳转链路，经同进程 connection 服务的 authenticatedUrl 注入
 *     dsh 访问令牌，并以可配置饼干名透传平台签发的免登票据与目标页签；
 *   - /api/aiops/chat：Copilot 流式诊断通道（SSE），由常驻 ACP 子进程
 *     （dsh --profile acp）按会话承载，替换逐消息冷启动；
 *   - /api/aiops/permission：ask 策略下权限请求的人工应答回填；
 *   - 方案推送：答复完成时把方案与动作块 POST 到平台 solutionsPath（Bearer 认证）。
 */
export function apply(ctx: Context, config: Config): void {
  const copilot = new AcpCopilotPool({
    dshRoot: config.dshRoot,
    sessionCwd: config.sessionCwd,
    patchPath: config.acpPatchPath,
    permission: config.permission,
    sandboxMode: config.sandboxMode,
    resolveApiKey: async () => (await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value,
    // 方案闭环钩子：Copilot 答复完成时把方案推送到平台审批。
    // 返回的 data 以 solution SSE 事件发给平台 Copilot 面板（渲染"去审批并下发"操作卡）；
    // 推送失败只回传 pushed:false，绝不影响诊断答复本身。
    onFinal: async ({ sessionId, message, text }) => {
      if (config.platformBearerToken === '' || text.trim() === '') return undefined
      const payload = {
        title: titleOf(message, text),
        question: message,
        plan: text,
        tools: parseExecActions(text),
        source: 'dsh-copilot',
        sessionId,
      }
      const response = await fetch(`${config.platformOrigin}${config.solutionsPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.platformBearerToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.solutionPushTimeoutMs),
      })
      if (!response.ok) {
        ctx.logger.warn(`platform-relay: solution push failed: HTTP ${response.status}`)
        return { pushed: false, reason: `平台返回 HTTP ${response.status}` }
      }
      const result = await response.json() as { status?: number; data?: { id?: string; page?: string } }
      if (result.status !== 0 || result.data?.id === undefined) {
        ctx.logger.warn(`platform-relay: solution push rejected: ${JSON.stringify(result).slice(0, 200)}`)
        return { pushed: false, reason: '平台拒绝接收方案' }
      }
      return {
        pushed: true,
        id: result.data.id,
        page: `${config.platformOrigin}${result.data.page ?? `/aiops/solutions?id=${result.data.id}`}`,
        actions: payload.tools.length,
      }
    },
  })

  const health = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const upstream = await fetch(`${config.platformOrigin}${config.healthPath}`, { signal: AbortSignal.timeout(config.requestTimeoutMs) })
      json(res, upstream.ok ? 200 : 502, { ok: upstream.ok, platform: config.platformOrigin, upstream: upstream.status })
    } catch (error) {
      json(res, 502, { ok: false, platform: config.platformOrigin, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const consoleEntry = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // 免登票据由平台在其会话内签发，此处仅透传给控制台页面；
      // 控制台挂载后凭票据向平台核销接口换取账号与角色完成免登
      const ticket = url.searchParams.get('ticket')
      const tab = url.searchParams.get('tab')
      const headers: Record<string, string | string[]> = { Location: ctx.connection.authenticatedUrl(config.consoleTarget) }
      const cookies: string[] = []
      if (ticket && /^[A-Za-z0-9_-]{10,200}$/.test(ticket)) {
        cookies.push(`${config.ticketCookieName}=${ticket}; Path=/; Max-Age=60; SameSite=Lax`)
      }
      if (tab && /^[a-z]+$/.test(tab)) cookies.push(`${config.tabCookieName}=${tab}; Path=/; Max-Age=60; SameSite=Lax`)
      if (cookies.length > 0) headers['Set-Cookie'] = cookies
      res.writeHead(302, headers)
      res.end()
    } catch (error) {
      text(res, 502, `控制台跳转失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const chat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const payload = await body(req)
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message) throw new Error('缺少 message')
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const send = (frame: SseEvent): void => {
      if (!res.writableEnded) res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    }
    const ac = new AbortController()
    res.on('close', () => { ac.abort() })
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined
    await copilot.prompt(sessionId === undefined ? { message } : { message, sessionId }, send, ac.signal)
    if (!res.writableEnded) res.end()
  }

  // 人工权限应答：Copilot 面板对 permission 事件点选「允许/拒绝」后回填给挂起的智能体
  const permissionAnswer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const payload = await body(req)
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    if (requestId === '') throw new Error('缺少 requestId')
    const answered = copilot.respondPermission(requestId, payload.allow === true)
    json(res, 200, { status: answered ? 0 : 1, msg: answered ? 'success' : '权限请求不存在或已超时' })
  }

  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }> = [
    { path: '/health', handler: health },
    { path: '/console', handler: consoleEntry },
    { path: '/api/aiops/chat', handler: chat },
    { path: '/api/aiops/permission', handler: permissionAnswer },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: route.path,
      handler: (req, res) => {
        cors(res)
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        void Promise.resolve(route.handler(req, res)).catch((error: unknown) => {
          if (!res.writableEnded) json(res, 200, { status: -1, msg: `中继异常：${error instanceof Error ? error.message : String(error)}` })
        })
      },
    }), `platform-relay: ${route.path}`)
  }
  ctx.effect(() => () => {
    void copilot.dispose()
  }, 'platform-relay: dispose')
}
