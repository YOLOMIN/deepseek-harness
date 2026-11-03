/**
 * Wire vocabulary of the aiopsMcp Remote namespace: registry MCP server rows,
 * paged listing, detail, connect/disconnect actions, and the failure taxonomy.
 *
 * @module @gac2/dsh-aiops-mcp-controller/types
 */

/** One MCP server row merging registry metadata with the live connection state. */
export interface AiopsMcpServerRow {
  /** Server name (registry identity). */
  readonly name: string
  readonly description: string
  readonly version: string
  /** MCP transport reported by the registry (`streamable-http` / `sse`). */
  readonly transport: string
  /** Endpoint URL from the registry remotes, scheme-normalized; empty when absent. */
  readonly url: string
  /** Declared or observed tool count; absent when the server was never connected here. */
  readonly toolCount?: number | undefined
  /** Whether this host currently holds a live mcp-client mount for the server. */
  readonly connected: boolean
  /** Registry publish time in epoch milliseconds, when known. */
  readonly time?: number | undefined
}

/** Full server detail for the console dialog: registry row plus declared tools. */
export interface AiopsMcpServerDetail {
  readonly row: AiopsMcpServerRow
  /** Declared tools (name + description), as published in the registry. */
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

/** Paged registry query accepted by the aiopsMcp namespace. */
export interface AiopsMcpQuery {
  /** Case-insensitive substring matched server-side against name/description. */
  readonly keyword?: string | undefined
  /** 1-based page number. */
  readonly page: number
  /** Page size, capped by the controller schema. */
  readonly pageSize: number
}

/** One page of MCP server rows. */
export interface AiopsMcpServerPage {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsMcpServerRow[]
  /** Count of servers currently connected on this host. */
  readonly connectedCount: number
}

/** Console-editable MCP settings: registry connection, platform token, console write credentials, and the invocation switch. */
export interface AiopsMcpSettings {
  /** MCP registry origin (the AI-registry adaptor port), e.g. `http://192.168.10.95:9080`. */
  readonly registryOrigin: string
  /** Registry namespace; the deployment's servers live in `public`. */
  readonly namespaceId: string
  /** Bearer token attached when connecting to a server endpoint. */
  readonly authToken: string
  /** Nacos console origin for register/unregister writes, e.g. `http://192.168.10.95:8080`. */
  readonly consoleOrigin: string
  /** Nacos console account used by register/unregister. */
  readonly consoleUsername: string
  /** Nacos console password used by register/unregister. */
  readonly consolePassword: string
  /** 自动调用：关闭后断开全部连接且不再允许新连接，智能体不再命中 MCP 工具。 */
  readonly autoInvoke: boolean
}

/** One server registration accepted by the aiopsMcp namespace; tools are discovered by handshake. */
export interface AiopsMcpRegisterInput {
  /** Server name; must satisfy `[A-Za-z0-9_-]{1,32}`. */
  readonly name: string
  readonly description: string
  /** MCP endpoint URL, e.g. `http://192.168.10.95:9091/mcp`. */
  readonly url: string
  /** Registry version label; defaults to `1.0.0`. */
  readonly version?: string | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed input; the field names the first offending member. */
    'aiops-mcp/invalid': { readonly field: string }
    /** The registry has no such server. */
    'aiops-mcp/not-found': { readonly name: string }
    /** The Nacos registry is unreachable or answered with an error. */
    'aiops-mcp/upstream': { readonly status: string }
    /** The endpoint refused the connection or the mount failed. */
    'aiops-mcp/connect': { readonly name: string }
    /** Invocation is switched off, so connecting is refused. */
    'aiops-mcp/disabled': Record<string, never>
    /** The Nacos console refused the register/unregister write. */
    'aiops-mcp/register': { readonly name: string }
  }
}
