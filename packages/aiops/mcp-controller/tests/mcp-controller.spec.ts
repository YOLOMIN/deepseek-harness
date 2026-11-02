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
    settingsPath: resolve(dir, 'settings.json'),
    requestTimeoutMs: 5000,
  }
  const controller = new AiopsMcpController(ctx, config)
  return { controller, dir }
}

/** Stub globalThis.fetch with the given handler; restore in afterEach. */
function stubFetch(handler: (url: string, init?: unknown) => { status?: number; json?: unknown; headers?: Record<string, string> }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const answer = handler(url)
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
      registryOrigin: 'http://registry.test', namespaceId: 'public', authToken: 'tok', autoInvoke: true,
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
