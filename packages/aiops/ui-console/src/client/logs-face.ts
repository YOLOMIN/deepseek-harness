/**
 * 日志管理的浏览器数据面：经 ctx.remote.aiopsLogs 查询宿主投影的智能体活动日志，
 * 详情经 uiWorkspace.openSession 打开所属会话的轨迹页，导出为查询结果的 JSON 下载。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ctx.remote and uiWorkspace merges into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@gac2/dsh-aiops-log-controller/remote'
import type { AiopsLogDetail, AiopsLogPage, AiopsLogQuery } from '@gac2/dsh-aiops-log-controller/types'

/** Logs tab data and action surface injected by the plugin apply closure. */
export interface AiopsLogsFace {
  /** Run one filtered, paged log query. */
  queryLogs: (input: AiopsLogQuery) => Promise<AiopsLogPage>
  /** Read one row's full committed event payload. */
  logDetail: (sessionId: string, seq: number) => Promise<AiopsLogDetail>
  /** Open the owning session's trace for one log row. */
  openLogSession: (sessionId: string) => void
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsLogs namespace and workspace navigation into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsLogsFace(ctx: ClientContext): AiopsLogsFace {
  return {
    queryLogs: async input => unwrap(await ctx.remote.aiopsLogs.query(input)),
    logDetail: async (sessionId, seq) => unwrap(await ctx.remote.aiopsLogs.detail({ sessionId, seq })),
    openLogSession: (sessionId) => { ctx.uiWorkspace.openSession(SessionId(sessionId)) },
  }
}
