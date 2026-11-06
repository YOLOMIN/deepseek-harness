/**
 * RAG knowledge-base management for the operations console: proxies the
 * KBMatrix data-infra API (FastAPI read/write surface) into the `aiopsRag`
 * browser namespace — knowledge-base list/create/delete, document paged
 * listing, upload and batch delete, chunk browsing, embedding-model options,
 * and a retrieval test. The platform account token is obtained through the
 * web front's login-local endpoint, cached in memory, and renegotiated once
 * on authentication failures.
 *
 * @module @gac2/dsh-aiops-rag-controller
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z as zod } from 'zod'
import type {
  AiopsRagBase, AiopsRagBaseCreateInput, AiopsRagBasePage, AiopsRagBaseQuery,
  AiopsRagChunkPage, AiopsRagChunkQuery, AiopsRagChunkRow,
  AiopsRagDocumentPage, AiopsRagDocumentQuery, AiopsRagDocumentRow,
  AiopsRagModelOption, AiopsRagSearchHit, AiopsRagSearchInput, AiopsRagSettings, AiopsRagUploadInput,
} from './types.ts'
import type { AiopsRagBaseUpdateInput, AiopsRagChunkUpdateInput } from './types.ts'

export type * from './types.ts'

/** Deployment choices for the RAG controller. */
export interface Config {
  /** KBMatrix data-infra API origin, e.g. `http://192.168.32.14:6061`. */
  apiOrigin: string
  /** KBMatrix web front origin issuing access tokens, e.g. `http://192.168.32.14:6060`. */
  authOrigin: string
  /** Platform account for login-local. */
  username: string
  /** Platform password for login-local. */
  password: string
  /** Read/write request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Document upload timeout in milliseconds; parsing large files is slower. */
  uploadTimeoutMs: number
  /** Display label of the connected platform (swap-ready when the deployment moves to another RAG vendor). */
  platformLabel: string
  /** Console-saved recall settings file; defaults to `~/.dsh/aiops-rag-settings.json`. */
  settingsPath: string
}

/** Validated deployment choices. */
export const Config = z.object({
  apiOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).required(),
  authOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).required(),
  username: z.string().min(1).required(),
  password: z.string().min(1).required(),
  requestTimeoutMs: z.number().min(1000).max(120_000).default(15_000),
  uploadTimeoutMs: z.number().min(10_000).max(600_000).default(120_000),
  platformLabel: z.string().min(1).default('KBMatrix 知识库平台'),
  settingsPath: z.string().min(1).default(join(homedir(), '.dsh', 'aiops-rag-settings.json')),
})

const baseQuerySchema = zod.object({
  keyword: zod.string().trim().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(200),
})

const createBaseSchema = zod.object({
  name: zod.string().trim().min(1, '知识库名称不能为空').max(64, '知识库名称 ≤64 字符'),
  description: zod.string().trim().max(500, '描述 ≤500 字符').optional(),
  embeddingModelId: zod.string().min(1),
  embeddingModelName: zod.string().min(1),
})

const idListSchema = zod.object({ ids: zod.array(zod.string().min(1)).min(1, '至少选择一条').max(200) })

const documentQuerySchema = zod.object({
  kbId: zod.string().min(1),
  name: zod.string().trim().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(100),
})

const uploadSchema = zod.object({
  kbId: zod.string().min(1),
  fileName: zod.string().trim().min(1, '文件名不能为空').max(200),
  contentBase64: zod.string().min(1),
})

const chunkQuerySchema = zod.object({
  kbId: zod.string().min(1),
  documentId: zod.string().min(1),
  content: zod.string().trim().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(100),
})

const updateBaseSchema = zod.object({
  id: zod.string().min(1),
  name: zod.string().trim().min(1, '知识库名称不能为空').max(64, '知识库名称 ≤64 字符'),
  description: zod.string().trim().max(500, '描述 ≤500 字符').optional(),
})

const updateChunkSchema = zod.object({
  id: zod.string().min(1),
  title: zod.string().trim().max(200).optional(),
  content: zod.string().trim().min(1, '分块内容不能为空').max(8000, '分块内容 ≤8000 字符'),
})

const settingsInputSchema = zod.object({
  recallEnabled: zod.boolean().optional(),
})

const searchSchema = zod.object({
  kbIds: zod.array(zod.string().min(1)).min(1, '至少选择一个知识库').max(20),
  text: zod.string().trim().min(1, '检索内容不能为空').max(2000),
  topK: zod.number().int().min(1).max(50).optional(),
})

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-rag/invalid', message, { field })
}

function upstream(status: string, message: string): RemoteError {
  return new RemoteError('aiops-rag/upstream', message, { status })
}

function authFailed(): RemoteError {
  return new RemoteError('aiops-rag/auth', '知识库平台认证失败或会话已过期，请检查控制台 RAG 对接账号配置', {})
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** RAG knowledge-base owner for the operations console. */
    aiopsRagController: AiopsRagController
  }
}

/** KBMatrix list-all envelope entry (fields read tolerantly; the platform evolves). */
interface PlatformBaseEntry {
  readonly id?: string
  readonly name?: string
  readonly category?: string
  readonly description?: string
  readonly document_count?: number
  readonly app_count?: number
  readonly storage_size?: number
  readonly embedding_model_name?: string
  readonly meta?: { readonly lifecycle?: { readonly step?: string; readonly status?: string; readonly updated_at?: string } }
}

/** KBMatrix paged envelope (`data.data` carries the rows). */
interface PlatformPageEnvelope<T> {
  readonly current?: number
  readonly total?: number
  readonly data?: T[]
}

interface PlatformDocumentEntry {
  readonly id?: string
  readonly kb_id?: string
  readonly name?: string
  readonly file_type?: string
  readonly file_size?: number
  readonly chunk_count?: number
  readonly status_name?: string
  readonly created_at?: string
  readonly create_user_name?: string
}

interface PlatformChunkEntry {
  readonly id?: string
  readonly title?: string
  readonly content?: string
  readonly active?: boolean
  readonly is_active?: boolean
}

interface PlatformModelEntry {
  readonly id?: string
  readonly customize_name?: string
  readonly model_name?: string
  readonly model_type?: string
}

/** Platform business envelope; `code` is the string "200" on success. */
interface PlatformEnvelope {
  readonly code?: string
  readonly message?: string
  readonly data?: unknown
}

const API_PREFIX = '/kb-matrix/data-infra/v1'

/**
 * Host owner of the `aiopsRag` namespace. Every method resolves the platform
 * token (logging in on demand, once retried after an authentication failure)
 * and maps platform envelopes into wire rows.
 */
export class AiopsRagController extends TypertRemoteService {
  private readonly config: Config
  private token: string | undefined

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsRagController', { namespace: 'aiopsRag' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
  }

  /**
   * List knowledge bases with a local keyword filter and paging; the
   * platform's list-all endpoint is unpaged, so the full list is fetched and
   * sliced locally (the same shape as the memory controller).
   * @param input - keyword filter plus paging.
   * @returns the filtered page of knowledge-base rows.
   */
  @Remote('listBases')
  async listBases(input: AiopsRagBaseQuery): Promise<AiopsRagBasePage> {
    const parsed = baseQuerySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const envelope = await this.callPlatform('GET', `${API_PREFIX}/kb-base/list-all`)
    const entries = (envelope.data as PlatformBaseEntry[] | undefined) ?? []
    const keyword = parsed.data.keyword?.toLowerCase()
    const rows = entries
      .map(entry => mapBase(entry))
      .filter(row => keyword === undefined || keyword === '' || `${row.name}\n${row.description}`.toLowerCase().includes(keyword))
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: rows.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: rows.slice(start, start + parsed.data.pageSize),
    }
  }

  /**
   * Create one knowledge base in the platform's `general` category.
   * @param input - name, optional description, and the embedding-model identity pair.
   */
  @Remote('createBase')
  async createBase(input: AiopsRagBaseCreateInput): Promise<{ readonly id: string }> {
    const parsed = createBaseSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', parsed.error.issues[0]?.message ?? '参数无效')
    const envelope = await this.callPlatform('POST', `${API_PREFIX}/kb-base/create`, {
      name: parsed.data.name,
      category: 'general',
      description: parsed.data.description ?? '',
      icon: 'icon-wenjianjia',
      embedding_model_id: parsed.data.embeddingModelId,
      embedding_model_name: parsed.data.embeddingModelName,
      meta: {},
    })
    // 平台创建成功时 data 直接是新库 id 字符串（兼容对象形态的 {id} 演进）
    const raw = envelope.data
    const id = typeof raw === 'string' ? raw : (raw as { readonly id?: string } | undefined)?.id
    if (id === undefined || id === '') throw upstream('create', '平台未返回新知识库标识')
    return { id }
  }

  /**
   * Delete knowledge bases by id batch.
   * @param input - the id list (1-200 entries).
   */
  @Remote('deleteBase')
  async deleteBase(input: { readonly ids: readonly string[] }): Promise<void> {
    const parsed = idListSchema.safeParse(input)
    if (!parsed.success) throw invalid('ids', parsed.error.issues[0]?.message ?? '参数无效')
    await this.callPlatform('POST', `${API_PREFIX}/kb-base/remove`, { ids: parsed.data.ids })
  }

  /**
   * Page documents of one knowledge base.
   * @param input - knowledge-base id, optional name filter, plus paging.
   * @returns the platform page mapped to document rows.
   */
  @Remote('pageDocuments')
  async pageDocuments(input: AiopsRagDocumentQuery): Promise<AiopsRagDocumentPage> {
    const parsed = documentQuerySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const query = new URLSearchParams({
      current: String(parsed.data.page),
      size: String(parsed.data.pageSize),
      kb_id: parsed.data.kbId,
    })
    if (parsed.data.name !== undefined && parsed.data.name !== '') query.set('name', parsed.data.name)
    const envelope = await this.callPlatform('GET', `${API_PREFIX}/kb-document/page?${query}`)
    const page = (envelope.data as PlatformPageEnvelope<PlatformDocumentEntry> | undefined) ?? {}
    const rows = (page.data ?? []).map(entry => mapDocument(entry))
    return { total: page.total ?? rows.length, page: parsed.data.page, pageSize: parsed.data.pageSize, rows }
  }

  /**
   * Upload one document into a knowledge base (multipart form; content arrives
   * base64 over the wire and is rehydrated into a Blob here).
   * @param input - knowledge-base id, file name, and base64 content.
   */
  @Remote('uploadDocument')
  async uploadDocument(input: AiopsRagUploadInput): Promise<void> {
    const parsed = uploadSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', parsed.error.issues[0]?.message ?? '参数无效')
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64'))
    } catch {
      throw invalid('contentBase64', '文件内容不是合法的 base64')
    }
    if (bytes.byteLength === 0) throw invalid('contentBase64', '文件内容为空')
    const form = new FormData()
    form.set('kb_id', parsed.data.kbId)
    form.append('files', new Blob([bytes.buffer as ArrayBuffer]), parsed.data.fileName)
    await this.callPlatform('POST', `${API_PREFIX}/kb-document/upload-files`, form, this.config.uploadTimeoutMs)
  }

  /**
   * Delete documents by id batch.
   * @param input - the document id list (1-200 entries).
   */
  @Remote('deleteDocuments')
  async deleteDocuments(input: { readonly ids: readonly string[] }): Promise<void> {
    const parsed = idListSchema.safeParse(input)
    if (!parsed.success) throw invalid('ids', parsed.error.issues[0]?.message ?? '参数无效')
    await this.callPlatform('POST', `${API_PREFIX}/kb-document/remove`, { ids: parsed.data.ids })
  }

  /**
   * Page chunks of one document, optionally content-filtered by the platform.
   * @param input - knowledge-base and document id, optional content filter, plus paging.
   * @returns the platform page mapped to chunk rows.
   */
  @Remote('pageChunks')
  async pageChunks(input: AiopsRagChunkQuery): Promise<AiopsRagChunkPage> {
    const parsed = chunkQuerySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const envelope = await this.callPlatform('POST', `${API_PREFIX}/kb-document/chunk/page`, {
      current: parsed.data.page,
      size: parsed.data.pageSize,
      kb_id: parsed.data.kbId,
      document_id: parsed.data.documentId,
      ...(parsed.data.content === undefined || parsed.data.content === '' ? {} : { content: parsed.data.content }),
    })
    const page = (envelope.data as PlatformPageEnvelope<PlatformChunkEntry> | undefined) ?? {}
    const rows = (page.data ?? []).map(entry => mapChunk(entry))
    return { total: page.total ?? rows.length, page: parsed.data.page, pageSize: parsed.data.pageSize, rows }
  }

  /**
   * Run one retrieval test over the selected knowledge bases. Hybrid mode is
   * tried first; when the platform's vector side yields nothing (embedding
   * collection not warmed), the test retries once in keyword mode so the
   * console still demonstrates recall against the same corpus.
   * @param input - knowledge-base ids, query text, and an optional hit cap.
   * @returns the hit list with tolerant field mapping.
   */
  @Remote('searchKb')
  async searchKb(input: AiopsRagSearchInput): Promise<readonly AiopsRagSearchHit[]> {
    const parsed = searchSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', parsed.error.issues[0]?.message ?? '参数无效')
    const topK = parsed.data.topK ?? 5
    const request = async (mode: string, ids: readonly string[]) => (await this.callPlatform('POST', `${API_PREFIX}/kb-search/search`, {
      search_mode: mode,
      kb_ids: ids,
      search_text: parsed.data.text,
      top_k: topK,
      is_rerank: false,
    })).data as ReadonlyArray<Record<string, unknown>> | undefined
    // 平台侧已知缺陷（2026-11-06 实测）：多库 hybrid 直接 500（COMMON_1000 system error），
    // 向量侧未预热时 hybrid/embedding 恒空。策略：hybrid 全量 → keyword 全量 → 逐库 keyword 合并。
    const hybrid = await this.trySearch(() => request('hybrid', parsed.data.kbIds))
    if (hybrid !== undefined && hybrid.length > 0) return hybrid.map(hit => mapHit(hit))
    const keyword = await this.trySearch(() => request('keyword', parsed.data.kbIds))
    if (keyword !== undefined) return keyword.map(hit => mapHit(hit))
    const merged: AiopsRagSearchHit[] = []
    for (const id of parsed.data.kbIds) {
      const single = await this.trySearch(() => request('keyword', [id]))
      if (single !== undefined) merged.push(...single.map(hit => mapHit(hit)))
    }
    return merged
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK)
  }

  /** Run one search variant; platform business failures degrade to undefined for the fallback chain. */
  private async trySearch(
    run: () => Promise<ReadonlyArray<Record<string, unknown>> | undefined>,
  ): Promise<ReadonlyArray<Record<string, unknown>> | undefined> {
    try {
      return await run()
    } catch (error: unknown) {
      if (error instanceof RemoteError && error.code === 'aiops-rag/upstream') return undefined
      throw error
    }
  }

  /**
   * Report the connected platform's display label and API origin for the console header.
   * @returns the configured label and origin.
   */
  @Remote('getPlatformInfo')
  getPlatformInfo(): Promise<{ readonly label: string; readonly apiOrigin: string }> {
    return Promise.resolve({ label: this.config.platformLabel, apiOrigin: this.config.apiOrigin })
  }

  /**
   * Update a knowledge base's name/description.
   * @param input - base id plus the new name and optional description.
   */
  @Remote('updateBase')
  async updateBase(input: AiopsRagBaseUpdateInput): Promise<void> {
    const parsed = updateBaseSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', parsed.error.issues[0]?.message ?? '参数无效')
    await this.callPlatform('POST', `${API_PREFIX}/kb-base/update`, {
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description ?? '',
    })
  }

  /**
   * Update one chunk's content (and optionally title).
   * @param input - chunk id, new content, optional new title.
   */
  @Remote('updateChunk')
  async updateChunk(input: AiopsRagChunkUpdateInput): Promise<void> {
    const parsed = updateChunkSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', parsed.error.issues[0]?.message ?? '参数无效')
    await this.callPlatform('POST', `${API_PREFIX}/kb-document/chunk/update`, {
      id: parsed.data.id,
      content: parsed.data.content,
      ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
    })
  }

  /**
   * Read the console-saved recall settings (recall switch); missing file means defaults.
   * @returns the effective recall settings.
   */
  @Remote('getSettings')
  async getSettings(): Promise<AiopsRagSettings> {
    return this.readSettings()
  }

  /**
   * Persist one recall-settings patch.
   * @param input - the fields to change.
   * @returns the saved settings.
   */
  @Remote('saveSettings')
  async saveSettings(input: { readonly recallEnabled?: boolean | undefined }): Promise<AiopsRagSettings> {
    const parsed = settingsInputSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', '设置无效')
    const current = await this.readSettings()
    const next: AiopsRagSettings = {
      recallEnabled: parsed.data.recallEnabled ?? current.recallEnabled,
    }
    await mkdir(dirname(this.config.settingsPath), { recursive: true })
    await writeFile(this.config.settingsPath, JSON.stringify(next, null, 2), 'utf8')
    return next
  }

  /** Read the persisted recall settings, defaulting to enabled. */
  private async readSettings(): Promise<AiopsRagSettings> {
    let raw: string | undefined
    try {
      raw = await readFile(this.config.settingsPath, 'utf8')
    } catch {
      // 设置文件缺失或不可读时按默认（召回开启）
    }
    if (raw !== undefined) {
      try {
        const parsed = settingsInputSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return { recallEnabled: parsed.data.recallEnabled ?? true }
      } catch {
        // JSON 损坏等价于无覆盖
      }
    }
    return { recallEnabled: true }
  }

  /**
   * Host-side recall for the knowledge_search tool: search every knowledge
   * base with the recall switch honored. Not a wire method.
   * @param query - the search text.
   * @param topK - hit cap.
   * @returns hits with the switch state; disabled yields an empty list.
   */
  async recallKnowledge(query: string, topK: number): Promise<{ readonly enabled: boolean; readonly hits: readonly AiopsRagSearchHit[] }> {
    const settings = await this.readSettings()
    if (!settings.recallEnabled) return { enabled: false, hits: [] }
    const bases = await this.listBases({ page: 1, pageSize: 200 })
    if (bases.rows.length === 0) return { enabled: true, hits: [] }
    const hits = await this.searchKb({ kbIds: bases.rows.map(row => row.id), text: query, topK })
    return { enabled: true, hits }
  }

  /**
   * List embedding models selectable at knowledge-base creation.
   * @returns the platform's Embedding-typed models as id/name options.
   */
  @Remote('listEmbeddingModels')
  async listEmbeddingModels(): Promise<readonly AiopsRagModelOption[]> {
    const envelope = await this.callPlatform('GET', `${API_PREFIX}/kb-model/list`)
    const entries = (envelope.data as PlatformModelEntry[] | undefined) ?? []
    return entries
      .filter(entry => entry.model_type === 'Embedding' && entry.id !== undefined)
      .map(entry => ({ id: entry.id ?? '', name: entry.customize_name ?? entry.model_name ?? entry.id ?? '' }))
  }

  /**
   * Call the platform API with the cached token; on an authentication failure
   * the token is renegotiated once and the call retried.
   * @param method - HTTP method.
   * @param path - request path (with query) under the API origin.
   * @param body - JSON body, FormData, or omitted for GET.
   * @param timeoutMs - request timeout override (uploads run longer).
   * @returns the platform envelope's data payload.
   */
  private async callPlatform(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<PlatformEnvelope> {
    if (this.token === undefined) await this.login()
    try {
      return await this.callOnce(method, path, body, timeoutMs)
    } catch (error: unknown) {
      if (!(error instanceof RemoteError) || error.code !== 'aiops-rag/auth') throw error
      // 会话过期：重新登录后重试一次
      await this.login()
      return await this.callOnce(method, path, body, timeoutMs)
    }
  }

  /** One platform call with the current token. */
  private async callOnce(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs?: number): Promise<PlatformEnvelope> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token ?? ''}` }
    let payload: string | FormData | undefined
    if (body instanceof FormData) {
      payload = body
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      payload = JSON.stringify(body)
    }
    let response: Response
    try {
      response = await fetch(`${this.config.apiOrigin}${path}`, {
        method,
        headers,
        body: payload ?? null,
        signal: AbortSignal.timeout(timeoutMs ?? this.config.requestTimeoutMs),
      })
    } catch (error: unknown) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw upstream(
        timeout ? 'timeout' : 'unreachable',
        timeout ? `知识库平台响应超时（>${(timeoutMs ?? this.config.requestTimeoutMs) / 1000}s）` : `知识库平台不可达：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 401 || response.status === 403) throw authFailed()
    let envelope: PlatformEnvelope
    try {
      envelope = await response.json() as PlatformEnvelope
    } catch {
      throw upstream(String(response.status), `知识库平台返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!response.ok) {
      throw upstream(String(response.status), `知识库平台返回 HTTP ${response.status}：${envelope.message ?? ''}`)
    }
    if (envelope.code !== '200') {
      if (envelope.code === '401' || envelope.code === '403') throw authFailed()
      throw upstream(envelope.code ?? 'unknown', envelope.message ?? '知识库平台业务错误')
    }
    return envelope
  }

  /** Login through the web front and cache the access token. */
  private async login(): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.config.authOrigin}/kb-matrix-base/v1/auth/login-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch (error: unknown) {
      throw upstream('unreachable', `知识库平台认证服务不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw authFailed()
    const envelope = await response.json().catch(() => undefined) as PlatformEnvelope | undefined
    const token = (envelope?.data as { readonly accessToken?: string } | undefined)?.accessToken
    if (token === undefined || token === '') throw authFailed()
    this.token = token
  }
}

/** Map one platform base entry to a wire row. */
function mapBase(entry: PlatformBaseEntry): AiopsRagBase {
  const lifecycle = entry.meta?.lifecycle
  return {
    id: entry.id ?? '',
    name: entry.name ?? '',
    category: entry.category ?? '',
    description: entry.description ?? '',
    documentCount: entry.document_count ?? 0,
    appCount: entry.app_count ?? 0,
    storageSize: entry.storage_size ?? 0,
    embeddingModelName: entry.embedding_model_name ?? '',
    lifecycleStep: lifecycle?.step ?? '',
    lifecycleStatus: lifecycle?.status ?? '',
    ...(lifecycle?.updated_at === undefined ? {} : { updatedAt: Date.parse(lifecycle.updated_at) || undefined }),
  }
}

/** Map one platform document entry to a wire row. */
function mapDocument(entry: PlatformDocumentEntry): AiopsRagDocumentRow {
  return {
    id: entry.id ?? '',
    kbId: entry.kb_id ?? '',
    name: entry.name ?? '',
    fileType: entry.file_type ?? '',
    fileSize: entry.file_size ?? 0,
    chunkCount: entry.chunk_count ?? 0,
    statusName: entry.status_name ?? '',
    ...(entry.created_at === undefined ? {} : { createdAt: Date.parse(entry.created_at) || undefined }),
    createdBy: entry.create_user_name ?? '',
  }
}

/** Map one platform chunk entry to a wire row. */
function mapChunk(entry: PlatformChunkEntry): AiopsRagChunkRow {
  const active = entry.active ?? entry.is_active
  return {
    id: entry.id ?? '',
    title: entry.title ?? '',
    content: entry.content ?? '',
    ...(active === undefined ? {} : { active }),
  }
}

/** Map one untyped retrieval hit to a wire row, tolerating platform field drift. */
function mapHit(hit: Record<string, unknown>): AiopsRagSearchHit {
  const content = firstString(hit, ['content', 'text', 'segment', 'chunk']) ?? ''
  const score = typeof hit.score === 'number' ? hit.score : typeof hit.similarity === 'number' ? hit.similarity : undefined
  const documentName = firstString(hit, ['document_name', 'doc_name', 'file_name', 'document'])
  const chunkId = firstString(hit, ['chunk_id', 'segment_id', 'id'])
  return {
    content,
    ...(score === undefined ? {} : { score }),
    ...(documentName === undefined ? {} : { documentName }),
    ...(chunkId === undefined ? {} : { chunkId }),
  }
}

/** Read the first present string member among candidate keys. */
function firstString(hit: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = hit[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export default AiopsRagController
