/** Operations console entry and Copilot routes for GAC2 AIOps. */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Deployment choices for the operations integration routes. */
export interface Config {
  /** Base origin of the operations platform, used by the health probe. */
  platformOrigin: string
  /** DSH repository or installation root used to launch headless Copilot turns. */
  dshRoot: string
  /** Workspace shared by headless Copilot and Web Sessions. */
  sessionCwd: string
  /** DSH startup log containing the current browser launch token. */
  consoleLogPath: string
  /** Upstream health-check deadline in milliseconds. */
  requestTimeoutMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  platformOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).default('http://192.168.10.95:9091'),
  dshRoot: z.string().min(1).default(process.cwd()),
  sessionCwd: z.string().min(1).default(process.cwd()),
  consoleLogPath: z.string().min(1).default(resolve(process.cwd(), '..', 'dsh-web.log')),
  requestTimeoutMs: z.number().min(1).max(120_000).default(3_000),
})

const MAX_BODY_BYTES = 64 * 1024

/** Services required by the integration routes. */
export const inject = ['webServer', 'credentials']

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
 *   - /console：平台"智能运维控制台入口"跳转链路，向重定向注入 dsh 访问 token，
 *     并透传平台签发的免登票据（pf_ticket）与目标页签（pf_tab）；
 *   - /api/aiops/chat：运维 Copilot 流式诊断通道（SSE），spawn headless 推理子进程。
 */
export function apply(ctx: Context, config: Config): void {
  const children = new Set<ChildProcess>()

  const health = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const upstream = await fetch(`${config.platformOrigin}/api/aiops/health`, { signal: AbortSignal.timeout(config.requestTimeoutMs) })
      json(res, upstream.ok ? 200 : 502, { ok: upstream.ok, platform: config.platformOrigin, upstream: upstream.status })
    } catch (error) {
      json(res, 502, { ok: false, platform: config.platformOrigin, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const consoleEntry = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const log = await readFile(config.consoleLogPath, 'utf8')
      const matches = [...log.matchAll(/token=[A-Za-z0-9_-]{20,}/g)]
      const latest = matches.at(-1)
      if (latest === undefined) throw new Error('未在 dsh-web.log 中找到 token')
      const token = latest[0]
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // 免登票据由平台标准接口 /api/aiops/ticket 在平台会话内签发，此处仅透传给控制台页面；
      // 控制台挂载后凭票据向平台 /api/aiops/ticket-login 核销，换取账号与角色完成免登
      const ticket = url.searchParams.get('ticket')
      const tab = url.searchParams.get('tab')
      const headers: Record<string, string | string[]> = { Location: `http://127.0.0.1:3080/?${token}` }
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
    const send = (event: string, data: unknown): void => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const args = [
      '--import', pathToFileURL(join(config.dshRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
      join(config.dshRoot, 'apps/cli/src/bin.ts'),
      '--profile', 'headless', '--patch', join(config.dshRoot, 'aiops-headless.patch.yml'), '--json',
    ]
    if (typeof payload.sessionId === 'string' && payload.sessionId) args.push('--session-id', payload.sessionId)
    args.push(message)
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(config.dshRoot, 'tsconfig.base.json') }
    const credential = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
    if (credential) childEnv.DEEPSEEK_API_KEY = credential.value
    const child = spawn(process.execPath, args, { cwd: config.sessionCwd, env: childEnv })
    children.add(child)
    child.once('close', () => { children.delete(child) })
    let buffer = ''
    let finalSeen = false
    child.stdout.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let event: Record<string, unknown>
        try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }
        if (event.type === 'session') send('session', { sessionId: event.sessionId || event.id || event.session })
        else if (event.type === 'text' && event.text) send('delta', { kind: 'text', text: event.text })
        else if (event.type === 'thinking' && event.text) send('delta', { kind: 'thinking', text: event.text })
        else if (event.type === 'tool_call') send('tool', { phase: 'call', name: event.name || event.tool, args: event.args })
        else if (event.type === 'tool_result') send('tool', { phase: 'result', name: event.name || event.tool })
        else if (event.type === 'status' && event.text) send('status', { text: event.text })
        else if (event.type === 'final') { finalSeen = true; send('final', { text: event.text || '' }) }
        else if (event.type === 'error') send('error', { message: event.message || '运行错误' })
      }
    })
    let errorBuffer = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      errorBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    let childDone = false
    child.on('close', (code: number | null) => {
      childDone = true
      if (!finalSeen) {
        if (code === 0) send('final', { text: '' })
        else send('error', { message: `诊断执行异常退出（${code}）：${errorBuffer.trim().split('\n').pop() || '未知错误'}`.slice(0, 300) })
      }
      if (!res.writableEnded) res.end()
    })
    res.on('close', () => { if (!childDone) child.kill() })
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
    for (const child of children) child.kill()
    children.clear()
  }, 'aiops-auth-relay: dispose')
}
