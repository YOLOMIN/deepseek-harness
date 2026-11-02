/**
 * MCP 接口管理的浏览器数据面：经 ctx.remote.aiopsMcp 查询 Nacos MCP 注册中心清单、
 * 查看详情、连接/断开 MCP Server（连接即动态挂载 mcp-client，工具即时对智能体可见），
 * 并读写注册中心对接与调用开关设置。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@gac2/dsh-aiops-mcp-controller/remote'
import type {
  AiopsMcpQuery, AiopsMcpServerDetail, AiopsMcpServerPage, AiopsMcpSettings,
} from '@gac2/dsh-aiops-mcp-controller/types'

/** MCP tab data and action surface injected by the plugin apply closure. */
export interface AiopsMcpFace {
  /** Run one filtered, paged registry query merged with live connection state. */
  listServers: (input: AiopsMcpQuery) => Promise<AiopsMcpServerPage>
  /** Read one server's registry row plus the tools observed at connect time. */
  getServerDetail: (name: string) => Promise<AiopsMcpServerDetail>
  /** Connect one registry server: handshake the endpoint and mount its tools. */
  connectServer: (name: string) => Promise<number>
  /** Disconnect one server: unmount its tools from this host. */
  disconnectServer: (name: string) => Promise<void>
  /** Read the effective settings (console override or plugin config). */
  getSettings: () => Promise<AiopsMcpSettings>
  /** Persist the settings override; later operations use it immediately. */
  saveSettings: (input: AiopsMcpSettings) => Promise<AiopsMcpSettings>
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsMcp namespace into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsMcpFace(ctx: ClientContext): AiopsMcpFace {
  return {
    listServers: async input => unwrap(await ctx.remote.aiopsMcp.list(input)),
    getServerDetail: async name => unwrap(await ctx.remote.aiopsMcp.detail({ name })),
    connectServer: async name => unwrap(await ctx.remote.aiopsMcp.connect({ name })).toolCount,
    disconnectServer: async (name) => { unwrap(await ctx.remote.aiopsMcp.disconnect({ name })) },
    getSettings: async () => unwrap(await ctx.remote.aiopsMcp.getSettings()),
    saveSettings: async input => unwrap(await ctx.remote.aiopsMcp.saveSettings(input)),
  }
}
