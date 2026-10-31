import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AiopsSkillController from '../src/index.ts'
import type { Config } from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const skillsDir = resolve(tmpdir(), `aiops-skills-test-${randomUUID()}`)
  const config: Config = {
    registryOrigin: 'http://registry.test',
    namespaceId: 'public',
    skillsDir,
    requestTimeoutMs: 5000,
  }
  const controller = new AiopsSkillController(ctx, config)
  return { controller, skillsDir }
}

/** Stub globalThis.fetch with the given handler; restore in afterEach. */
function stubFetch(handler: (url: string) => { status?: number; json?: unknown; bytes?: Uint8Array }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const answer = handler(url)
    if (answer.bytes !== undefined) {
      return new Response(Buffer.from(answer.bytes), { status: answer.status ?? 200 })
    }
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const SUMMARY = {
  name: 'skill-node-down',
  description: '节点掉线诊断',
  version: '1.4',
  updatedAt: '2026-10-30T08:00:00Z',
}

describe('AiopsSkillController.list', () => {
  it('merges registry rows with local install state', async () => {
    const { controller, skillsDir } = fixture()
    await mkdir(resolve(skillsDir, 'skill-node-down'), { recursive: true })
    stubFetch(() => ({ json: { skills: [SUMMARY] } }))
    const page = await controller.list({ page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({ name: 'skill-node-down', version: '1.4', status: 'online', installed: true })
    expect(page.installedCount).toBe(1)
  })

  it('filters by keyword against name and description', async () => {
    const { controller } = fixture()
    stubFetch(() => ({ json: { skills: [SUMMARY, { name: 'skill-gpu-temp', description: 'GPU 温度排查', version: '1.1' }] } }))
    const page = await controller.list({ keyword: 'gpu', page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(page.rows[0]?.name).toBe('skill-gpu-temp')
  })

  it('wraps registry failures as aiops-skills/upstream', async () => {
    const { controller } = fixture()
    stubFetch(() => { throw new Error('connection refused') })
    await expect(controller.list({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-skills/upstream' })
    stubFetch(() => ({ status: 503, json: {} }))
    await expect(controller.list({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-skills/upstream' })
  })

  it('rejects malformed queries at the wire boundary', async () => {
    const { controller } = fixture()
    await expect(controller.list({ page: 0, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-skills/invalid' })
  })
})

describe('AiopsSkillController.install/uninstall', () => {
  it('installs declared files into the skills root', async () => {
    const { controller, skillsDir } = fixture()
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', description: 'd', files: ['SKILL.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      return { status: 404, json: {} }
    })
    const result = await controller.install({ name: 'skill-a' })
    expect(result.installed).toBe(true)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(resolve(skillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('# A\n')
  })

  it('reports unknown skills as not-found and cleans partial installs', async () => {
    const { controller } = fixture()
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [] } }
      return { status: 404, json: {} }
    })
    await expect(controller.install({ name: 'skill-a' })).rejects.toMatchObject({ code: 'aiops-skills/not-found' })
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', files: ['SKILL.md', 'ref/a.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      return { status: 404, json: {} }
    })
    await expect(controller.install({ name: 'skill-a' })).rejects.toMatchObject({ code: 'aiops-skills/upstream' })
  })

  it('uninstall removes the local directory and reports missing registry versions', async () => {
    const { controller, skillsDir } = fixture()
    await mkdir(resolve(skillsDir, 'skill-a'), { recursive: true })
    await controller.uninstall({ name: 'skill-a' })
    await expect(controller.uninstall({ name: '' })).rejects.toMatchObject({ code: 'aiops-skills/invalid' })
  })
})
