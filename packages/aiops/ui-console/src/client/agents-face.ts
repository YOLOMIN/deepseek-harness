/**
 * 智能体管理的浏览器数据面：经 ctx.remote.aiopsAgents 访问宿主注册表，
 * 经 uiWorkspace.startSession 以正式通道按预设打开会话。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote and uiWorkspace merges into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@gac2/dsh-aiops-agent-controller/remote'
import type {
  AiopsAgentCreateInput, AiopsAgentRow, AiopsAgentUpdateInput,
} from '@gac2/dsh-aiops-agent-controller/types'
import { closeConsolePanel } from './initial-tab.ts'

/** Agents tab data and action surface injected by the plugin apply closure. */
export interface AiopsAgentsFace {
  /** Load the full roster (builtin plus console-created), stats included. */
  listAgents: () => Promise<AiopsAgentRow[]>
  /** Create one console-managed agent. */
  createAgent: (input: AiopsAgentCreateInput) => Promise<AiopsAgentRow>
  /** Apply one configuration edit to a console-managed agent. */
  updateAgent: (input: AiopsAgentUpdateInput) => Promise<AiopsAgentRow>
  /** Destroy one console-managed agent and retire its preset. */
  removeAgent: (id: string) => Promise<void>
  /** Open a new session bound to the given preset and return to the conversation view. */
  openAgentSession: (presetId: string) => void
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsAgents namespace and workspace navigation into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsAgentsFace(ctx: ClientContext): AiopsAgentsFace {
  return {
    listAgents: async () => unwrap(await ctx.remote.aiopsAgents.list()).agents,
    createAgent: async input => unwrap(await ctx.remote.aiopsAgents.create(input)).agent,
    updateAgent: async input => unwrap(await ctx.remote.aiopsAgents.update(input)).agent,
    removeAgent: async (id) => { unwrap(await ctx.remote.aiopsAgents.destroy({ id })) },
    openAgentSession: (presetId) => {
      try { localStorage.setItem('aiops.pendingAgent', presetId) } catch { /* 存储不可用时跳过归属标记 */ }
      // 先关闭控制台面板：面板关闭是一次布局导航，后到会取代会话导航（supersede）并丢弃新会话。
      closeConsolePanel()
      ctx.uiWorkspace.startSession(undefined, { agentPreset: presetId })
      // 触发会话树重算以完成归属落账与徽标渲染（会话异步创建，多次派发确保落账）
      for (const ms of [200, 500, 900, 1400, 2000, 2800]) {
        setTimeout(() => window.dispatchEvent(new Event('aiops-account')), ms)
      }
    },
  }
}
