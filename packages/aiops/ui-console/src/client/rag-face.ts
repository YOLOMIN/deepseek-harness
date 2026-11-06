/**
 * RAG 管理的浏览器数据面：经 ctx.remote.aiopsRag 查询宿主侧的 KBMatrix 代理——
 * 知识库清单/创建/删除、文档分页/上传/删除、分块浏览、嵌入模型选项与检索测试。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@gac2/dsh-aiops-rag-controller/remote'
import type {
  AiopsRagBaseCreateInput, AiopsRagBasePage, AiopsRagBaseQuery, AiopsRagBaseUpdateInput, AiopsRagChunkUpdateInput, AiopsRagSettings,
  AiopsRagChunkPage, AiopsRagChunkQuery,
  AiopsRagDocumentPage, AiopsRagDocumentQuery,
  AiopsRagModelOption, AiopsRagSearchHit,
} from '@gac2/dsh-aiops-rag-controller/types'

/** RAG tab data and action surface injected by the plugin apply closure. */
export interface AiopsRagFace {
  /** Report the connected platform's display label and API origin. */
  getPlatformInfo: () => Promise<{ readonly label: string; readonly apiOrigin: string }>
  /** Page knowledge bases with an optional keyword filter. */
  listBases: (input: AiopsRagBaseQuery) => Promise<AiopsRagBasePage>
  /** Create one knowledge base. */
  createBase: (input: AiopsRagBaseCreateInput) => Promise<{ readonly id: string }>
  /** Update a knowledge base's name/description. */
  updateBase: (input: AiopsRagBaseUpdateInput) => Promise<void>
  /** Update one chunk's content. */
  updateChunk: (input: AiopsRagChunkUpdateInput) => Promise<void>
  /** Read the recall settings. */
  getSettings: () => Promise<AiopsRagSettings>
  /** Persist one recall-settings patch. */
  saveSettings: (input: { readonly recallEnabled?: boolean | undefined }) => Promise<AiopsRagSettings>
  /** Delete knowledge bases by id batch. */
  deleteBase: (ids: readonly string[]) => Promise<void>
  /** Page documents of one knowledge base. */
  pageDocuments: (input: AiopsRagDocumentQuery) => Promise<AiopsRagDocumentPage>
  /** Upload one document (base64 content rehydrated host-side). */
  uploadDocument: (kbId: string, fileName: string, contentBase64: string) => Promise<void>
  /** Delete documents by id batch. */
  deleteDocuments: (ids: readonly string[]) => Promise<void>
  /** Page chunks of one document. */
  pageChunks: (input: AiopsRagChunkQuery) => Promise<AiopsRagChunkPage>
  /** Run one retrieval test (hybrid first, keyword fallback when the vector side is cold). */
  searchKb: (kbIds: readonly string[], text: string, topK?: number) => Promise<readonly AiopsRagSearchHit[]>
  /** List embedding-model options for base creation. */
  listEmbeddingModels: () => Promise<readonly AiopsRagModelOption[]>
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsRag namespace into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsRagFace(ctx: ClientContext): AiopsRagFace {
  return {
    getPlatformInfo: async () => unwrap(await ctx.remote.aiopsRag.getPlatformInfo()),
    listBases: async input => unwrap(await ctx.remote.aiopsRag.listBases(input)),
    createBase: async input => unwrap(await ctx.remote.aiopsRag.createBase(input)),
    updateBase: async (input) => { unwrap(await ctx.remote.aiopsRag.updateBase(input)) },
    updateChunk: async (input) => { unwrap(await ctx.remote.aiopsRag.updateChunk(input)) },
    getSettings: async () => unwrap(await ctx.remote.aiopsRag.getSettings()),
    saveSettings: async input => unwrap(await ctx.remote.aiopsRag.saveSettings(input)),
    deleteBase: async (ids) => { unwrap(await ctx.remote.aiopsRag.deleteBase({ ids })) },
    pageDocuments: async input => unwrap(await ctx.remote.aiopsRag.pageDocuments(input)),
    uploadDocument: async (kbId, fileName, contentBase64) => {
      unwrap(await ctx.remote.aiopsRag.uploadDocument({ kbId, fileName, contentBase64 }))
    },
    deleteDocuments: async (ids) => { unwrap(await ctx.remote.aiopsRag.deleteDocuments({ ids })) },
    pageChunks: async input => unwrap(await ctx.remote.aiopsRag.pageChunks(input)),
    searchKb: async (kbIds, text, topK) => {
      const input = { kbIds, text, ...(topK === undefined ? {} : { topK }) }
      return unwrap(await ctx.remote.aiopsRag.searchKb(input))
    },
    listEmbeddingModels: async () => unwrap(await ctx.remote.aiopsRag.listEmbeddingModels()),
  }
}
