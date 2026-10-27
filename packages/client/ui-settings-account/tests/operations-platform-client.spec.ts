import { afterEach, expect, it, vi } from 'vitest'
import { operationsHealth, operationsLogin, operationsTicketLogin } from '../src/client/operations-platform.ts'

const platform = {
  id: 'other', name: 'Other', loginUrl: 'https://adapter.example/login',
  ticketLoginUrl: 'https://adapter.example/ticket', healthUrl: 'https://adapter.example/health',
}

afterEach(() => { vi.unstubAllGlobals() })

it('uses the selected adapter for login, ticket exchange, and health checks', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, data: { role: 2 } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 0, data: { username: 'operator', role: 1 } })))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(operationsLogin(platform, 'operator', 'secret')).resolves.toMatchObject({ status: 0, role: 2 })
  await expect(operationsTicketLogin(platform, 'one-time')).resolves.toMatchObject({ status: 0, username: 'operator', role: 1 })
  await expect(operationsHealth(platform)).resolves.toBe(true)
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([platform.loginUrl, platform.ticketLoginUrl, platform.healthUrl])
  expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify({ username: 'operator', password: 'secret' }))
  expect(fetchMock.mock.calls[1]![1].body).toBe(JSON.stringify({ ticket: 'one-time' }))
})

it('sanitizes adapter responses and does not contact an absent health endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    status: 0, msg: 42, data: { username: 42, role: 'admin', token: 'do-not-forward' },
  })))
  vi.stubGlobal('fetch', fetchMock)
  await expect(operationsLogin(platform, 'operator', 'secret')).resolves.toEqual({
    status: 0, msg: undefined, username: undefined, role: undefined,
  })
  await expect(operationsHealth({ ...platform, healthUrl: '' })).resolves.toBe(false)
  expect(fetchMock).toHaveBeenCalledOnce()
})
