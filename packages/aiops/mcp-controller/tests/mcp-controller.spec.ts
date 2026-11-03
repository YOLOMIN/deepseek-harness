import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AiopsMcpController from '../src/index.ts'
import type { Config } from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const dir = resolve(tmpdir(), `aiops-mcp-test-${randomUUID()}`)
  const config: Config = {
    registryOrigin: 'http://registry.test',
    namespaceId: 'public',
    authToken: 'tok',
    consoleOrigin: 'http://console.test:8080',
    consoleUsername: 'nacos',
    consolePassword: 'nacos',
    settingsPath: resolve(dir, 'settings.json'),
    requestTimeoutMs: 5000,
    consoleTimeoutMs: 10000,
  }
  const controller = new AiopsMcpController(ctx, config)
  return { controller, dir }
}

/** Stub globalThis.fetch with the given handler; restore in afterEach. */
type FetchAnswer = { status?: number; json?: unknown; headers?: Record<string, string> }
function stubFetch(handler: (url: string, init?: { method?: string; body?: string }) => FetchAnswer): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const answer = handler(url, init as { method?: string; body?: string } | undefined)
    return new Response(JSON.stringify(answer.json ?? {}), {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
    })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const SERVER = {
  name: 'ks-scmms-ops',
  description: '高性能集群监控平台运维能力',
  version: '1.0.0',
  remotes: [{ type: 'streamable-http', url: 'null://192.168.10.95:9091/mcp' }],
}

const SETTINGS = {
  registryOrigin: 'http://override.test:9080',
  namespaceId: 'ops',
  authToken: 'tok2',
  consoleOrigin: 'http://console.test:8080',
  consoleUsername: 'nacos',
  consolePassword: 'nacos',
  autoInvoke: true,
}

describe('AiopsMcpController.list', () => {
  it('merges registry rows with live connection state and normalizes null:// URLs', async () => {
    const { controller } = fixture()
    stubFetch(() => ({ json: { servers: [{ server: SERVER }] } }))
    const page = await controller.list({ page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({
      name: 'ks-scmms-ops',
      version: '1.0.0',
      transport: 'streamable-http',
      url: 'http://192.168.10.95:9091/mcp',
      connected: false,
    })
    expect(page.connectedCount).toBe(0)
  })

  it('filters by keyword against name and description', async () => {
    const { controller } = fixture()
    stubFetch(() => ({ json: { servers: [{ server: SERVER }, { server: { name: 'other', description: 'x' } }] } }))
    const page = await controller.list({ keyword: 'scmms', page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(page.rows[0]?.name).toBe('ks-scmms-ops')
  })

  it('retries once on abort and reports a friendly timeout message after two failures', async () => {
    const { controller } = fixture()
    let calls = 0
    stubFetch(() => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      return { json: { servers: [{ server: SERVER }] } }
    })
    const page = await controller.list({ page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(calls).toBe(2)
    stubFetch(() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) })
    await expect(controller.list({ page: 1, pageSize: 10 })).rejects.toThrow(/超时/)
  })

  it('wraps registry failures as aiops-mcp/upstream', async () => {
    const { controller } = fixture()
    stubFetch(() => { throw new Error('connection refused') })
    await expect(controller.list({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-mcp/upstream' })
    stubFetch(() => ({ status: 503, json: {} }))
    await expect(controller.list({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-mcp/upstream' })
  })
})

describe('AiopsMcpController settings', () => {
  it('falls back to plugin config and honors the persisted override', async () => {
    const { controller, dir } = fixture()
    expect(await controller.getSettings()).toEqual({
      registryOrigin: 'http://registry.test',
      namespaceId: 'public',
      authToken: 'tok',
      consoleOrigin: 'http://console.test:8080',
      consoleUsername: 'nacos',
      consolePassword: 'nacos',
      autoInvoke: true,
    })
    await controller.saveSettings(SETTINGS)
    expect(await controller.getSettings()).toEqual(SETTINGS)
    let hit = ''
    stubFetch((url) => {
      hit = url
      return { json: { servers: [] } }
    })
    await controller.list({ page: 1, pageSize: 10 })
    expect(hit.startsWith('http://override.test:9080/v0/servers')).toBe(true)
    expect(hit).toContain('namespaceId=ops')
    expect(dir).toBeTruthy()
  })

  it('rejects invalid settings at the wire boundary', async () => {
    const { controller } = fixture()
    await expect(controller.saveSettings({ ...SETTINGS, registryOrigin: 'nope' }))
      .rejects.toMatchObject({ code: 'aiops-mcp/invalid' })
  })
})

describe('AiopsMcpController detail/connect guards', () => {
  it('serves detail for a known server and rejects unknown ones', async () => {
    const { controller } = fixture()
    stubFetch(() => ({ json: { servers: [{ server: SERVER }] } }))
    const detail = await controller.detail({ name: 'ks-scmms-ops' })
    expect(detail.row.name).toBe('ks-scmms-ops')
    expect(detail.tools).toEqual([])
    await expect(controller.detail({ name: 'ghost' })).rejects.toMatchObject({ code: 'aiops-mcp/not-found' })
  })

  it('refuses connect when invocation is off, for unknown servers, and without an endpoint', async () => {
    const { controller } = fixture()
    await controller.saveSettings({ ...SETTINGS, autoInvoke: false })
    await expect(controller.connect({ name: 'ks-scmms-ops' })).rejects.toMatchObject({ code: 'aiops-mcp/disabled' })
    await controller.saveSettings(SETTINGS)
    stubFetch(() => ({ json: { servers: [] } }))
    await expect(controller.connect({ name: 'ghost' })).rejects.toMatchObject({ code: 'aiops-mcp/not-found' })
    stubFetch(() => ({ json: { servers: [{ server: { name: 'noep', description: 'd' } }] } }))
    await expect(controller.connect({ name: 'noep' })).rejects.toMatchObject({ code: 'aiops-mcp/invalid' })
  })

  it('surfaces handshake failures as aiops-mcp/connect before mounting', async () => {
    const { controller } = fixture()
    stubFetch((url) => {
      if (url.includes('/v0/servers')) return { json: { servers: [{ server: SERVER }] } }
      return { status: 401, json: {} }
    })
    await expect(controller.connect({ name: 'ks-scmms-ops' })).rejects.toMatchObject({ code: 'aiops-mcp/connect' })
  })
})

describe('AiopsMcpController register/unregister', () => {
  it('discovers tools by handshake and writes server/tool specs through the console', async () => {
    const { controller } = fixture()
    const calls: Array<{ url: string; method: string }> = []
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/v0/servers')) return { json: { servers: [] } }
      if (url.endsWith('/v1/auth/login')) return { json: { accessToken: 'tok-console' } }
      if (url.includes('/v3/console/ai/mcp')) return { json: { code: 0, data: 'id-1' } }
      if (url.includes('192.168.10.95:9091/mcp')) {
        const body = JSON.parse(init?.body ?? '{}') as { method?: string }
        if (body.method === 'initialize') return { json: { result: { capabilities: {} } }, headers: { 'mcp-session-id': 's1' } }
        if (body.method === 'notifications/initialized') return { json: {} }
        if (body.method === 'tools/list') {
          return { json: { result: { tools: [{ name: 'metric-query', description: 'q', inputSchema: { type: 'object' } }] } } }
        }
      }
      return { status: 404, json: {} }
    })
    const result = await controller.register({ name: 'ks-scmms-ops', description: 'd', url: 'http://192.168.10.95:9091/mcp' })
    expect(result).toEqual({ registered: true, toolCount: 1 })
    const write = calls.find(call => call.url.includes('/v3/console/ai/mcp'))
    expect(write?.method).toBe('POST')
    expect(write?.url).toContain('accessToken=tok-console')
  })

  it('unregisters through the console and tolerates a missing live connection', async () => {
    const { controller } = fixture()
    const calls: Array<{ url: string; method: string }> = []
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.endsWith('/v1/auth/login')) return { json: { accessToken: 'tok-console' } }
      if (url.includes('/v3/console/ai/mcp')) return { json: { code: 0, data: 'ok' } }
      return { json: { servers: [] } }
    })
    await expect(controller.unregister({ name: 'ks-scmms-ops' })).resolves.toEqual({ unregistered: true })
    const write = calls.find(call => call.url.includes('/v3/console/ai/mcp'))
    expect(write?.method).toBe('DELETE')
  })

  it('rejects duplicate registration and invalid input at the wire boundary', async () => {
    const { controller } = fixture()
    stubFetch(() => ({ json: { servers: [{ server: SERVER }] } }))
    await expect(controller.register({ name: 'ks-scmms-ops', description: '', url: 'http://x.test/mcp' }))
      .rejects.toMatchObject({ code: 'aiops-mcp/invalid' })
    await expect(controller.register({ name: 'bad name!', description: '', url: 'http://x.test/mcp' }))
      .rejects.toMatchObject({ code: 'aiops-mcp/invalid' })
  })
})
