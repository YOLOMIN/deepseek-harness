/**
 * Wire vocabulary of the aiopsRag Remote namespace: KBMatrix knowledge-base
 * rows, paged document/chunk listings, upload/delete actions, embedding-model
 * options, retrieval-test hits, and the failure taxonomy.
 *
 * @module @gac2/dsh-aiops-rag-controller/types
 */

/** One knowledge-base row of the console list. */
export interface AiopsRagBase {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  /** Document count reported by the platform. */
  readonly documentCount: number
  /** Bound application count reported by the platform. */
  readonly appCount: number
  /** Occupied storage in bytes. */
  readonly storageSize: number
  /** Embedding model display name backing this base. */
  readonly embeddingModelName: string
  /** Vector-collection lifecycle step (empty when the platform reports none). */
  readonly lifecycleStep: string
  /** Vector-collection lifecycle status (empty when the platform reports none). */
  readonly lifecycleStatus: string
  /** Last lifecycle update, epoch milliseconds; absent when unknown. */
  readonly updatedAt?: number | undefined
}

/** Paged knowledge-base query accepted by the aiopsRag namespace. */
export interface AiopsRagBaseQuery {
  /** Case-insensitive substring matched against name/description. */
  readonly keyword?: string | undefined
  /** 1-based page number. */
  readonly page: number
  readonly pageSize: number
}

/** One page of knowledge-base rows. */
export interface AiopsRagBasePage {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsRagBase[]
}

/** Knowledge-base creation accepted by the aiopsRag namespace. */
export interface AiopsRagBaseCreateInput {
  readonly name: string
  readonly description?: string | undefined
  /** Embedding model identity pair from listEmbeddingModels. */
  readonly embeddingModelId: string
  readonly embeddingModelName: string
}

/** One document row inside a knowledge base. */
export interface AiopsRagDocumentRow {
  readonly id: string
  readonly kbId: string
  readonly name: string
  readonly fileType: string
  /** File size in bytes. */
  readonly fileSize: number
  readonly chunkCount: number
  /** Platform pipeline state display text, e.g. 已完成. */
  readonly statusName: string
  /** Parse time in epoch milliseconds; absent when unknown. */
  readonly createdAt?: number | undefined
  readonly createdBy: string
}

/** Paged document query inside one knowledge base. */
export interface AiopsRagDocumentQuery {
  readonly kbId: string
  /** Case-sensitive platform-side name substring filter. */
  readonly name?: string | undefined
  readonly page: number
  readonly pageSize: number
}

/** One page of document rows. */
export interface AiopsRagDocumentPage {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsRagDocumentRow[]
}

/** One document upload accepted by the aiopsRag namespace; content travels base64. */
export interface AiopsRagUploadInput {
  readonly kbId: string
  readonly fileName: string
  /** Base64-encoded file content. */
  readonly contentBase64: string
}

/** One chunk row of a document. */
export interface AiopsRagChunkRow {
  readonly id: string
  readonly title: string
  readonly content: string
  /** Whether the chunk participates in retrieval; absent when the platform omits it. */
  readonly active?: boolean | undefined
}

/** Paged chunk query inside one document. */
export interface AiopsRagChunkQuery {
  readonly kbId: string
  readonly documentId: string
  /** Chunk-content substring filter evaluated by the platform. */
  readonly content?: string | undefined
  readonly page: number
  readonly pageSize: number
}

/** One page of chunk rows. */
export interface AiopsRagChunkPage {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsRagChunkRow[]
}

/** Retrieval-test request accepted by the aiopsRag namespace. */
export interface AiopsRagSearchInput {
  /** Knowledge bases searched together. */
  readonly kbIds: readonly string[]
  readonly text: string
  /** Hit cap; defaults to 5, capped by the controller schema. */
  readonly topK?: number | undefined
}

/** One retrieval-test hit, field-mapped tolerantly from the platform's untyped payload. */
export interface AiopsRagSearchHit {
  /** Hit text body. */
  readonly content: string
  /** Similarity score when reported. */
  readonly score?: number | undefined
  /** Owning document name when reported. */
  readonly documentName?: string | undefined
  /** Owning chunk identity when reported. */
  readonly chunkId?: string | undefined
}

/** Embedding-model option for the create-base dialog. */
export interface AiopsRagModelOption {
  readonly id: string
  readonly name: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed input; the field names the first offending member. */
    'aiops-rag/invalid': { readonly field: string }
    /** The knowledge base or document does not exist. */
    'aiops-rag/not-found': { readonly id: string }
    /** The KBMatrix platform is unreachable, timed out, or answered with an error. */
    'aiops-rag/upstream': { readonly status: string }
    /** Platform authentication failed or the session expired twice in a row. */
    'aiops-rag/auth': Record<string, never>
  }
}

/** Knowledge-base info update accepted by the aiopsRag namespace. */
export interface AiopsRagBaseUpdateInput {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

/** Chunk content update accepted by the aiopsRag namespace. */
export interface AiopsRagChunkUpdateInput {
  readonly id: string
  readonly title?: string | undefined
  readonly content: string
}

/** Console-editable RAG settings (persisted beside the DSH user root). */
export interface AiopsRagSettings {
  /** 知识召回注入推理链路：关闭后 knowledge_search 工具拒绝召回。 */
  readonly recallEnabled: boolean
}
