import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AiopsRagController from '../src/index.ts'
import type { Config } from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const dir = resolve(tmpdir(), `aiops-rag-test-${randomUUID()}`)
  const config: Config = {
    apiOrigin: 'http://kb-api.test',
    authOrigin: 'http://kb-web.test',
    username: 'tester',
    password: 'secret',
    requestTimeoutMs: 5000,
    uploadTimeoutMs: 20000,
    platformLabel: 'KBMatrix 知识库平台',
    settingsPath: resolve(dir, 'settings.json'),
  }
  const controller = new AiopsRagController(ctx, config)
  return { controller, dir }
}

/** Stub globalThis.fetch with the given handler; restored in afterEach. Returns the spy. */
type FetchAnswer = { status?: number; json?: unknown }
function stubFetch(handler: (url: string, init?: { method?: string; body?: unknown }) => FetchAnswer) {
  const spy = vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const answer = handler(url, init as { method?: string; body?: unknown } | undefined)
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const LOGIN_ANSWER = { json: { code: '200', message: '', data: { accessToken: 'tok-1' } } }

const BASE_ENTRY = {
  id: 'kb-1',
  name: '运维手册',
  category: 'general',
  description: 'for test',
  document_count: 3,
  app_count: 1,
  storage_size: 22126,
  embedding_model_name: 'qwen3.7-text-embedding-flash',
  meta: { lifecycle: { step: 'vector_collection', status: 'READY', updated_at: '2026-10-27T16:15:09' } },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AiopsRagController.listBases', () => {
  it('logs in on the first call and maps platform base rows', async () => {
    const { controller } = fixture()
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      return { json: { code: '200', message: 'success', data: [BASE_ENTRY] } }
    })
    const page = await controller.listBases({ page: 1, pageSize: 10 })
    expect(seen[0]).toContain('/kb-matrix-base/v1/auth/login-local')
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({
      id: 'kb-1',
      name: '运维手册',
      documentCount: 3,
      storageSize: 22126,
      embeddingModelName: 'qwen3.7-text-embedding-flash',
      lifecycleStatus: 'READY',
    })
    expect(page.rows[0]?.updatedAt).toBe(Date.parse('2026-10-27T16:15:09'))
  })

  it('filters by keyword against name and description, and pages locally', async () => {
    const { controller } = fixture()
    stubFetch(url => url.includes('/auth/login-local')
      ? LOGIN_ANSWER
      : { json: { code: '200', data: [BASE_ENTRY, { ...BASE_ENTRY, id: 'kb-2', name: '硬件规范', description: 'x' }] } })
    const page = await controller.listBases({ keyword: '硬件', page: 1, pageSize: 1 })
    expect(page.total).toBe(1)
    expect(page.rows[0]?.id).toBe('kb-2')
  })

  it('renegotiates the token once when the platform answers 401', async () => {
    const { controller } = fixture()
    let logins = 0
    let lists = 0
    stubFetch((url) => {
      if (url.includes('/auth/login-local')) {
        logins += 1
        return LOGIN_ANSWER
      }
      lists += 1
      return lists === 1 ? { status: 401, json: {} } : { json: { code: '200', data: [] } }
    })
    const page = await controller.listBases({ page: 1, pageSize: 10 })
    expect(logins).toBe(2)
    expect(page.total).toBe(0)
  })

  it('surfaces a platform business error with its message', async () => {
    const { controller } = fixture()
    stubFetch(url => url.includes('/auth/login-local')
      ? LOGIN_ANSWER
      : { json: { code: '50001', message: '知识库不存在' } })
    await expect(controller.listBases({ page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-rag/upstream', message: '知识库不存在' })
  })

  it('rejects invalid paging input before any HTTP call', async () => {
    const { controller } = fixture()
    const spy = stubFetch(() => LOGIN_ANSWER)
    await expect(controller.listBases({ page: 0, pageSize: 10 })).rejects.toMatchObject({ code: 'aiops-rag/invalid' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('AiopsRagController.createBase / deleteBase', () => {
  it('creates a base with the general category and returns its id', async () => {
    const { controller } = fixture()
    let sent: unknown
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      return { json: { code: '200', data: 'kb-new' } }
    })
    const result = await controller.createBase({ name: '经验库', embeddingModelId: 'm-1', embeddingModelName: 'qwen' })
    expect(result.id).toBe('kb-new')
    expect(sent).toMatchObject({ name: '经验库', category: 'general', embedding_model_id: 'm-1' })
  })

  it('rejects an over-long name before any HTTP call', async () => {
    const { controller } = fixture()
    const spy = stubFetch(() => LOGIN_ANSWER)
    await expect(controller.createBase({ name: 'x'.repeat(65), embeddingModelId: 'm-1', embeddingModelName: 'q' }))
      .rejects.toMatchObject({ code: 'aiops-rag/invalid' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('deletes bases by id batch', async () => {
    const { controller } = fixture()
    let sent: unknown
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      return { json: { code: '200', data: null } }
    })
    await controller.deleteBase({ ids: ['kb-1', 'kb-2'] })
    expect(sent).toEqual({ ids: ['kb-1', 'kb-2'] })
  })
})

describe('AiopsRagController.pageDocuments / pageChunks', () => {
  const DOC = {
    id: 'doc-1',
    kb_id: 'kb-1',
    name: '产品.docx',
    file_type: 'docx',
    file_size: 22126,
    chunk_count: 4,
    status_name: '已完成',
    created_at: '2026-10-27T17:58:30',
    create_user_name: 'superadmin',
  }

  it('maps the platform paged envelope to document rows', async () => {
    const { controller } = fixture()
    let seenUrl = ''
    stubFetch((url) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      seenUrl = url
      return { json: { code: '200', data: { current: 1, total: 1, data: [DOC] } } }
    })
    const page = await controller.pageDocuments({ kbId: 'kb-1', page: 2, pageSize: 5, name: '产品' })
    expect(seenUrl).toContain('current=2')
    expect(seenUrl).toContain('size=5')
    expect(seenUrl).toContain('kb_id=kb-1')
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({ id: 'doc-1', name: '产品.docx', chunkCount: 4, statusName: '已完成', createdBy: 'superadmin' })
  })

  it('pages chunks with the document identity', async () => {
    const { controller } = fixture()
    let sent: Record<string, unknown> | undefined
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      return { json: { code: '200', data: { current: 1, total: 2, data: [{ id: 'c-1', title: '产品手册', content: '第一段', active: true }] } } }
    })
    const page = await controller.pageChunks({ kbId: 'kb-1', documentId: 'doc-1', page: 1, pageSize: 10 })
    expect(sent).toMatchObject({ current: 1, size: 10, kb_id: 'kb-1', document_id: 'doc-1' })
    expect(page.rows[0]).toMatchObject({ id: 'c-1', title: '产品手册', active: true })
  })
})

describe('AiopsRagController.uploadDocument / deleteDocuments', () => {
  it('uploads base64 content as multipart form data', async () => {
    const { controller } = fixture()
    let sawForm = false
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      if (init?.body instanceof FormData) {
        sawForm = true
        expect(init.body.get('kb_id')).toBe('kb-1')
        const file = init.body.get('files')
        expect(file).toBeInstanceOf(Blob)
      }
      return { json: { code: '200', data: null } }
    })
    await controller.uploadDocument({ kbId: 'kb-1', fileName: 'a.md', contentBase64: Buffer.from('# 标题').toString('base64') })
    expect(sawForm).toBe(true)
  })

  it('rejects empty file content', async () => {
    const { controller } = fixture()
    const spy = stubFetch(() => LOGIN_ANSWER)
    await expect(controller.uploadDocument({ kbId: 'kb-1', fileName: 'a.md', contentBase64: '' }))
      .rejects.toMatchObject({ code: 'aiops-rag/invalid' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('deletes documents by id batch', async () => {
    const { controller } = fixture()
    let sent: unknown
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      return { json: { code: '200', data: null } }
    })
    await controller.deleteDocuments({ ids: ['doc-1'] })
    expect(sent).toEqual({ ids: ['doc-1'] })
  })
})

describe('AiopsRagController.searchKb / listEmbeddingModels', () => {
  it('maps hybrid-search hits tolerantly', async () => {
    const { controller } = fixture()
    let sent: Record<string, unknown> | undefined
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      return { json: { code: '200', data: [{ content: '命中段', score: 0.87, document_name: '产品.docx', chunk_id: 'c-1' }] } }
    })
    const hits = await controller.searchKb({ kbIds: ['kb-1'], text: '巡检', topK: 3 })
    expect(sent).toMatchObject({ search_mode: 'hybrid', kb_ids: ['kb-1'], search_text: '巡检', top_k: 3 })
    expect(hits[0]).toEqual({ content: '命中段', score: 0.87, documentName: '产品.docx', chunkId: 'c-1' })
  })

  it('falls back to keyword mode when hybrid yields no hits', async () => {
    const { controller } = fixture()
    const modes: string[] = []
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { search_mode: string } : undefined
      modes.push(body?.search_mode ?? '')
      return body?.search_mode === 'hybrid'
        ? { json: { code: '200', data: [] } }
        : { json: { code: '200', data: [{ content: '关键词命中', score: 0.5, document_name: 'a.docx', id: 'c-9' }] } }
    })
    const hits = await controller.searchKb({ kbIds: ['kb-1'], text: '巡检' })
    expect(modes).toEqual(['hybrid', 'keyword'])
    expect(hits[0]).toMatchObject({ content: '关键词命中', documentName: 'a.docx' })
  })

  it('lists only Embedding-typed models as options', async () => {
    const { controller } = fixture()
    stubFetch(url => url.includes('/auth/login-local')
      ? LOGIN_ANSWER
      : {
        json: {
          code: '200',
          data: [
            { id: 'm-emb', customize_name: 'qwen3.7-embedding', model_type: 'Embedding' },
            { id: 'm-llm', customize_name: 'deepseek-v4.1-flash', model_type: 'LLM' },
          ],
        },
      })
    const options = await controller.listEmbeddingModels()
    expect(options).toEqual([{ id: 'm-emb', name: 'qwen3.7-embedding' }])
  })
})

describe('AiopsRagController.updateBase / updateChunk', () => {
  it('updates base name and description', async () => {
    const { controller } = fixture()
    let sent: Record<string, unknown> | undefined
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      return { json: { code: '200', data: null } }
    })
    await controller.updateBase({ id: 'kb-1', name: '新名称', description: '新描述' })
    expect(sent).toEqual({ id: 'kb-1', name: '新名称', description: '新描述' })
  })

  it('updates chunk content', async () => {
    const { controller } = fixture()
    let sent: Record<string, unknown> | undefined
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      sent = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      return { json: { code: '200', data: null } }
    })
    await controller.updateChunk({ id: 'c-1', content: '修订后的内容' })
    expect(sent).toEqual({ id: 'c-1', content: '修订后的内容' })
  })

  it('rejects empty chunk content before any HTTP call', async () => {
    const { controller } = fixture()
    const spy = stubFetch(() => LOGIN_ANSWER)
    await expect(controller.updateChunk({ id: 'c-1', content: '' })).rejects.toMatchObject({ code: 'aiops-rag/invalid' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('AiopsRagController recall settings + recallKnowledge', () => {
  it('recall defaults to enabled and searches every base', async () => {
    const { controller, dir } = fixture()
    const searched: string[] = []
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      if (url.includes('/kb-base/list-all')) return { json: { code: '200', data: [BASE_ENTRY] } }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { kb_ids: string[] } : undefined
      searched.push(...(body?.kb_ids ?? []))
      return { json: { code: '200', data: [{ content: '命中', score: 0.9, document_name: 'a.docx', id: 'c-1' }] } }
    })
    const result = await controller.recallKnowledge('巡检', 5)
    expect(result.enabled).toBe(true)
    expect(searched).toEqual(['kb-1'])
    expect(result.hits[0]?.documentName).toBe('a.docx')
    void dir
  })

  it('recall disabled by the saved switch returns empty without searching', async () => {
    const { controller } = fixture()
    stubFetch(url => url.includes('/auth/login-local') ? LOGIN_ANSWER : { json: { code: '200', data: [] } })
    await controller.saveSettings({ recallEnabled: false })
    const result = await controller.recallKnowledge('巡检', 5)
    expect(result).toEqual({ enabled: false, hits: [] })
    const settings = await controller.getSettings()
    expect(settings.recallEnabled).toBe(false)
  })
})

describe('AiopsRagController.searchKb resilience', () => {
  it('falls back to per-base keyword merge when multi-base search 500s', async () => {
    const { controller } = fixture()
    stubFetch((url, init) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { kb_ids: string[]; search_mode: string } : undefined
      // 平台缺陷复现：多库 hybrid/keyword 都 500；单库 keyword 正常
      if (body !== undefined && body.kb_ids.length > 1) return { json: { code: 'COMMON_1000', message: 'system error', data: null } }
      if (body?.search_mode === 'hybrid') return { json: { code: '200', data: [] } }
      return { json: { code: '200', data: [{ content: `命中-${body?.kb_ids[0]}`, score: 0.8, document_name: 'a.docx', id: 'c-1' }] } }
    })
    const hits = await controller.searchKb({ kbIds: ['kb-1', 'kb-2'], text: '巡检' })
    expect(hits).toHaveLength(2)
    expect(hits[0]?.content).toContain('命中-kb-')
  })
})

describe('AiopsRagController.searchKb local fallback', () => {
  it('falls back to local chunk substring matching when every platform mode is empty', async () => {
    const { controller } = fixture()
    stubFetch((url) => {
      if (url.includes('/auth/login-local')) return LOGIN_ANSWER
      if (url.includes('/kb-document/page')) {
        return { json: { code: '200', data: { current: 1, total: 1, data: [{ id: 'doc-1', name: '处置手册.md' }] } } }
      }
      if (url.includes('/chunk/page')) {
        return {
          json: {
            code: '200',
            data: {
              current: 1,
              total: 2,
              data: [
                { id: 'c-1', title: '', content: 'GPU 温度持续超过 85℃ 时先确认机房制冷与风扇转速' },
                { id: 'c-2', title: '', content: '队列阻塞先看调度器日志' },
              ],
            },
          },
        }
      }
      return { json: { code: '200', data: [] } }
    })
    const hits = await controller.searchKb({ kbIds: ['kb-1'], text: 'GPU 温度过高怎么处置' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.documentName).toBe('处置手册.md')
    expect(hits[0]?.content).toContain('85℃')
  })
})

describe('AiopsRagSettings platform connection override', () => {
  it('connection fields override the plugin Config and reset the cached token', async () => {
    const { controller } = fixture()
    const seen: string[] = []
    stubFetch((url) => {
      seen.push(url)
      if (url.includes('/auth/login-local')) return { json: { code: '200', message: '', data: { accessToken: `tok-${seen.length}` } } }
      return { json: { code: '200', data: [] } }
    })
    await controller.listBases({ page: 1, pageSize: 10 })
    expect(seen.some(u => u.includes('kb-api.test'))).toBe(true)

    await controller.saveSettings({ apiOrigin: 'http://kb-other.test:6061', platformLabel: 'RAGFlow' })
    const settings = await controller.getSettings()
    expect(settings.apiOrigin).toBe('http://kb-other.test:6061')
    expect(settings.platformLabel).toBe('RAGFlow')
    // 老配置字段不受影响
    expect(settings.authOrigin).toBe('http://kb-web.test')

    seen.length = 0
    await controller.listBases({ page: 1, pageSize: 10 })
    // 令牌作废后先在新认证地址重新登录，再走新 API 地址
    expect(seen.some(u => u.includes('kb-web.test') && u.includes('login-local'))).toBe(true)
    expect(seen.some(u => u.includes('kb-other.test'))).toBe(true)
  })
})
