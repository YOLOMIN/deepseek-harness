/** Operations console entry and Copilot routes for GAC2 AIOps. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { AcpCopilotPool, type CopilotPermission, type SseEvent } from './acp-copilot.ts'

/** Deployment choices for the operations integration routes. */
export interface Config {
  /** Base origin of the operations platform, used by the health probe. Required per deployment. */
  platformOrigin: string
  /** DSH repository or installation root used to launch the ACP Copilot child. */
  dshRoot: string
  /** Workspace shared by ACP Copilot sessions and Web Sessions. */
  sessionCwd: string
  /** Clean console URL that the entry redirect carries the process token to. */
  consoleTarget: string
  /** Persona/identity patch applied to the acp profile, resolved against dshRoot. */
  acpPatchPath: string
  /** Auto-answer policy for the Copilot agent's tool-permission prompts. */
  permission: CopilotPermission
  /** Upstream health-check deadline in milliseconds. */
  requestTimeoutMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  platformOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u),
  dshRoot: z.string().min(1).default(process.cwd()),
  sessionCwd: z.string().min(1).default(process.cwd()),
  consoleTarget: z.string().pattern(/^https?:\/\/[^\s]+$/u).default('http://127.0.0.1:3080/'),
  acpPatchPath: z.string().min(1).default('aiops-headless.patch.yml'),
  permission: z.union(['allow', 'reject']).default('allow'),
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
 * Mount the operations integration routes on an isolated webServer.
 *
 * 平台账户体系对接（账号口令认证 /api/aiops/login、免登票据 /api/aiops/ticket 与
 * /api/aiops/ticket-login、健康检查 /api/aiops/health）由运维平台以标准接口形式提供，
 * 本中继不再承担认证适配职责，仅保留两类控制端自身能力：
 *   - /console：平台"智能运维控制台入口"跳转链路，经同进程 connection 服务的
 *     authenticatedUrl 注入 dsh 访问令牌，并透传平台签发的免登票据（pf_ticket）
 *     与目标页签（pf_tab）；
 *   - /api/aiops/chat：运维 Copilot 流式诊断通道（SSE），由常驻 ACP 子进程
 *     （dsh --profile acp）按会话承载，替换逐消息冷启动。
 */
export function apply(ctx: Context, config: Config): void {
  const copilot = new AcpCopilotPool({
    dshRoot: config.dshRoot,
    sessionCwd: config.sessionCwd,
    patchPath: config.acpPatchPath,
    permission: config.permission,
    resolveApiKey: async () => (await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value,
  })

  const health = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const upstream = await fetch(`${config.platformOrigin}/api/aiops/health`, { signal: AbortSignal.timeout(config.requestTimeoutMs) })
      json(res, upstream.ok ? 200 : 502, { ok: upstream.ok, platform: config.platformOrigin, upstream: upstream.status })
    } catch (error) {
      json(res, 502, { ok: false, platform: config.platformOrigin, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const consoleEntry = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // 免登票据由平台标准接口 /api/aiops/ticket 在平台会话内签发，此处仅透传给控制台页面；
      // 控制台挂载后凭票据向平台 /api/aiops/ticket-login 核销，换取账号与角色完成免登
      const ticket = url.searchParams.get('ticket')
      const tab = url.searchParams.get('tab')
      const headers: Record<string, string | string[]> = { Location: ctx.connection.authenticatedUrl(config.consoleTarget) }
      const cookies: string[] = []
      if (ticket && /^[A-Za-z0-9_-]{10,200}$/.test(ticket)) {
        cookies.push(`pf_ticket=${ticket}; Path=/; Max-Age=60; SameSite=Lax`)
      }
      if (tab && /^[a-z]+$/.test(tab)) cookies.push(`pf_tab=${tab}; Path=/; Max-Age=60; SameSite=Lax`)
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

  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }> = [
    { path: '/health', handler: health },
    { path: '/console', handler: consoleEntry },
    { path: '/api/aiops/chat', handler: chat },
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
    }), `aiops-auth-relay: ${route.path}`)
  }
  ctx.effect(() => () => {
    void copilot.dispose()
  }, 'aiops-auth-relay: dispose')
}
