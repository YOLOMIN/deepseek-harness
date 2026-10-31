/**
 * 记忆管理的浏览器数据面：经 ctx.remote.aiopsMemory 查询宿主的经验记忆
 * （短期投影 + 长期晋升），支持查看原文、晋升、遗忘与召回配置读写；
 * 来源会话经 uiWorkspace.openSession 打开轨迹页。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ctx.remote and uiWorkspace merges into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@gac2/dsh-aiops-memory-controller/remote'
import type { AiopsMemoryDetail, AiopsMemoryPage, AiopsMemoryQuery, AiopsRecallConfig, AiopsRecallConfigInput } from '@gac2/dsh-aiops-memory-controller/types'

/** Memory tab data and action surface injected by the plugin apply closure. */
export interface AiopsMemoryFace {
  /** Run one filtered, paged memory query. */
  listMemories: (input: AiopsMemoryQuery) => Promise<AiopsMemoryPage>
  /** Read one memory's full conclusion text. */
  memoryDetail: (id: string) => Promise<AiopsMemoryDetail>
  /** Promote one short-term memory into the long-term tier. */
  promoteMemory: (id: string) => Promise<void>
  /** Forget one memory (delete long-term, suppress short-term). */
  forgetMemory: (id: string) => Promise<void>
  /** Read the recall configuration. */
  getRecallConfig: () => Promise<AiopsRecallConfig>
  /** Persist one recall-configuration patch. */
  saveRecallConfig: (input: AiopsRecallConfigInput) => Promise<AiopsRecallConfig>
  /** Open the owning session's trace for one memory row. */
  openMemorySession: (sessionId: string) => void
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsMemory namespace and workspace navigation into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsMemoryFace(ctx: ClientContext): AiopsMemoryFace {
  return {
    listMemories: async input => unwrap(await ctx.remote.aiopsMemory.list(input)),
    memoryDetail: async id => unwrap(await ctx.remote.aiopsMemory.detail({ id })),
    promoteMemory: async (id) => { unwrap(await ctx.remote.aiopsMemory.promote({ id })) },
    forgetMemory: async (id) => { unwrap(await ctx.remote.aiopsMemory.forget({ id })) },
    getRecallConfig: async () => unwrap(await ctx.remote.aiopsMemory.getRecallConfig()),
    saveRecallConfig: async input => unwrap(await ctx.remote.aiopsMemory.saveRecallConfig(input)),
    openMemorySession: (sessionId) => { ctx.uiWorkspace.openSession(SessionId(sessionId)) },
  }
}
