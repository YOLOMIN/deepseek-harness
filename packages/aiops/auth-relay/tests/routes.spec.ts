import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Config, apply, inject } from '../src/index.ts'
import { parseExecActions } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function fixture(healthy = true) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-aiops-relay-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const upstream = createServer((req, res) => {
    if (req.url === '/api/aiops/health') res.end('{"status":0,"msg":"","data":{"service":"ks-scmms"}}')
    else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('missing upstream address')
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }); upstream.closeAllConnections() })
  })
  const ctx = new Context()
  ctx.provide('connection', {
    authenticatedUrl: (base: string) => `${base}?token=test_token_12345678901234567890`,
  } as never)
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const plugin = ctx.plugin({ Config, apply, inject }, {
    platformOrigin: healthy ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1:1',
    dshRoot: process.cwd(), sessionCwd: process.cwd(), consoleTarget: 'http://127.0.0.1:3080/',
  })
  await plugin
  cleanups.push(async () => { await plugin.dispose(); await credentials.dispose(); await web.dispose(); await ctx.fiber.dispose() })
  return { origin: `http://127.0.0.1:${ctx.webServer.port}`, plugin }
}

it('reports upstream health through the isolated webServer', async () => {
  const { origin } = await fixture()
  const response = await fetch(`${origin}/health`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, upstream: 200 })
})

it('reports an unavailable upstream instead of only reporting the local process healthy', async () => {
  const { origin } = await fixture(false)
  const response = await fetch(`${origin}/health`)
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ ok: false })
})

it('reports a missing Copilot message without changing the HTTP protocol', async () => {
  const { origin } = await fixture()
  const response = await fetch(`${origin}/api/aiops/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: -1, msg: '中继异常：缺少 message' })
})

it('redirects with the current token and passes through the platform-issued ticket', async () => {
  const { origin, plugin } = await fixture()
  const ticket = 'platformIssuedTicket_abc123_-XYZ'
  const response = await fetch(`${origin}/console?ticket=${ticket}&tab=agents`, { redirect: 'manual' })
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('http://127.0.0.1:3080/?token=test_token_12345678901234567890')
  const cookies = response.headers.getSetCookie()
  expect(cookies.some(value => value.startsWith('pf_tab=agents'))).toBe(true)
  expect(cookies.some(value => value.startsWith(`pf_ticket=${ticket};`))).toBe(true)
  await plugin.dispose()
  expect((await fetch(`${origin}/health`)).status).toBe(404)
})

it('redirects without a ticket cookie when the ticket parameter is absent or malformed', async () => {
  const { origin } = await fixture()
  const response = await fetch(`${origin}/console?ticket=bad%20ticket&tab=agents`, { redirect: 'manual' })
  expect(response.status).toBe(302)
  const cookies = response.headers.getSetCookie()
  expect(cookies.some(value => value.startsWith('pf_ticket='))).toBe(false)
  expect(cookies.some(value => value.startsWith('pf_tab=agents'))).toBe(true)
})

describe('parseExecActions', () => {
  const NL = String.fromCharCode(10)
  const fence = (body: string) => '```json exec_actions' + NL + body + NL + '```'
  const fenceJson = (body: string) => '```json' + NL + body + NL + '```'

  it('parses the persona-styled exec_actions fenced block', () => {
    const plan = 'plan text' + NL + fence('[{"node":"kylinsec","cmd":"uptime","reason":"baseline"},{"node":"kylinsec","cmd":"df -h"}]')
    const actions = parseExecActions(plan)
    expect(actions).toHaveLength(2)
    expect(actions[0]).toEqual({ node: 'kylinsec', cmd: 'uptime', reason: 'baseline' })
    expect(actions[1]).toEqual({ node: 'kylinsec', cmd: 'df -h' })
  })

  it('accepts a bare fenced array and an exec_actions object form', () => {
    expect(parseExecActions(fenceJson('[{"node":"n1","cmd":"uptime"}]'))).toHaveLength(1)
    expect(parseExecActions(fenceJson('{"exec_actions":[{"node":"n1","cmd":"uptime"}]}'))).toHaveLength(1)
  })

  it('drops invalid entries and returns an empty list when no block exists', () => {
    expect(parseExecActions('no fenced block')).toEqual([])
    const actions = parseExecActions(fenceJson('[{"node":"","cmd":"x"},{"cmd":"y"},{"node":"n1","cmd":"uptime"}]'))
    expect(actions).toEqual([{ node: 'n1', cmd: 'uptime' }])
  })
})
