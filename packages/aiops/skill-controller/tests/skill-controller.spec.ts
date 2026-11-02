import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AiopsSkillController from '../src/index.ts'
import type { Config } from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const skillsDir = resolve(tmpdir(), `aiops-skills-test-${randomUUID()}`, 'skills')
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

describe('AiopsSkillController.installSkill/uninstallSkill', () => {
  it('installs declared files into the skills root', async () => {
    const { controller, skillsDir } = fixture()
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', description: 'd', files: ['SKILL.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      return { status: 404, json: {} }
    })
    const result = await controller.installSkill({ name: 'skill-a' })
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
    await expect(controller.installSkill({ name: 'skill-a' })).rejects.toMatchObject({ code: 'aiops-skills/not-found' })
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', files: ['SKILL.md', 'ref/a.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      return { status: 404, json: {} }
    })
    await expect(controller.installSkill({ name: 'skill-a' })).rejects.toMatchObject({ code: 'aiops-skills/upstream' })
  })

  it('uninstall removes the local directory and reports missing registry versions', async () => {
    const { controller, skillsDir } = fixture()
    await mkdir(resolve(skillsDir, 'skill-a'), { recursive: true })
    await controller.uninstallSkill({ name: 'skill-a' })
    await expect(controller.uninstallSkill({ name: '' })).rejects.toMatchObject({ code: 'aiops-skills/invalid' })
  })
})

describe('AiopsSkillController settings', () => {
  const override = { registryOrigin: 'http://override.test:9080', namespaceId: 'ops', autoDiscover: true, autoInvoke: true }

  it('falls back to plugin config and honors the persisted override', async () => {
    const { controller, skillsDir } = fixture()
    expect(await controller.getSettings()).toEqual({
      registryOrigin: 'http://registry.test', namespaceId: 'public', autoDiscover: true, autoInvoke: true,
    })
    const saved = await controller.saveSettings(override)
    expect(saved).toEqual(override)
    const persisted = JSON.parse(await readFile(resolve(skillsDir, '..', 'aiops-skill-registry.json'), 'utf8')) as unknown
    expect(persisted).toEqual(override)
    expect(await controller.getSettings()).toEqual(override)
    let hit = ''
    stubFetch((url) => {
      hit = url
      return { json: { skills: [] } }
    })
    await controller.list({ page: 1, pageSize: 10 })
    expect(hit.startsWith('http://override.test:9080/registry/ops/')).toBe(true)
  })

  it('rejects invalid settings at the wire boundary', async () => {
    const { controller } = fixture()
    await expect(controller.saveSettings({ ...override, registryOrigin: 'not-a-url' }))
      .rejects.toMatchObject({ code: 'aiops-skills/invalid' })
  })

  it('lists only local skills without contacting the registry when discovery is off', async () => {
    const { controller, skillsDir } = fixture()
    await mkdir(resolve(skillsDir, 'skill-local'), { recursive: true })
    let contacted = false
    stubFetch(() => {
      contacted = true
      return { json: { skills: [SUMMARY] } }
    })
    await controller.saveSettings({ ...override, autoDiscover: false })
    const page = await controller.list({ page: 1, pageSize: 10 })
    expect(contacted).toBe(false)
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({ name: 'skill-local', installed: true, invocable: true })
  })

  it('installs into quarantine while invocation is off and migrates on toggle', async () => {
    const { controller, skillsDir } = fixture()
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', description: 'd', files: ['SKILL.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      return { status: 404, json: {} }
    })
    const quarantine = resolve(skillsDir, '..', 'skills-quarantine')
    await controller.saveSettings({ ...override, autoInvoke: false })
    const installed = await controller.installSkill({ name: 'skill-a' })
    expect(installed.path).toBe(resolve(quarantine, 'skill-a'))
    const pageOff = await controller.list({ page: 1, pageSize: 10 })
    expect(pageOff.rows[0]).toMatchObject({ name: 'skill-a', installed: true, invocable: false })
    await controller.saveSettings({ ...override, autoInvoke: true })
    const pageOn = await controller.list({ page: 1, pageSize: 10 })
    expect(pageOn.rows[0]).toMatchObject({ name: 'skill-a', installed: true, invocable: true })
    expect(await readFile(resolve(skillsDir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('# A\n')
  })

  it('serves detail from the registry and reports local placement', async () => {
    const { controller, skillsDir } = fixture()
    stubFetch((url) => {
      if (url.endsWith('/index.json')) return { json: { skills: [{ name: 'skill-a', description: 'd', files: ['SKILL.md', 'ref/a.md'] }] } }
      if (url.includes('/skill-a/SKILL.md')) return { bytes: new TextEncoder().encode('# A\n') }
      if (url.includes('/skill-a/ref/a.md')) return { bytes: new TextEncoder().encode('# ref\n') }
      return { status: 404, json: {} }
    })
    await controller.installSkill({ name: 'skill-a' })
    const detail = await controller.detail({ name: 'skill-a' })
    expect(detail.row.installed).toBe(true)
    expect(detail.row.invocable).toBe(true)
    expect(detail.files).toEqual(['SKILL.md', 'ref/a.md'])
    expect(detail.localPath).toBe(resolve(skillsDir, 'skill-a'))
    await expect(controller.detail({ name: 'skill-x' })).rejects.toMatchObject({ code: 'aiops-skills/not-found' })
  })
})
