/**
 * Wire vocabulary of the aiopsAgents Remote namespace and the registry failure taxonomy.
 *
 * @module @gac2/dsh-aiops-agent-controller/types
 */

/** One agent row returned by the aiopsAgents namespace. */
export interface AiopsAgentRow {
  /** Preset identity, also recorded into new sessions' headers. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Duty description shown under the name. */
  readonly role: string
  /** Persona prefix of a console-managed agent, for edit-form prefill. */
  readonly personaPrefix?: string
  /** Deployment-seeded default: editable, but destroy is refused. */
  readonly builtin?: boolean | undefined
  /** Activation or registration diagnostic, when the preset is unusable. */
  readonly broken?: string
  /** Persisted sessions created with this preset. */
  readonly sessions: number
  /** Creation time of the newest session with this preset, epoch milliseconds. */
  readonly lastActiveAt?: number
}

/** Create input accepted by the aiopsAgents namespace. */
export interface AiopsAgentCreateInput {
  readonly name: string
  readonly role?: string
  readonly personaPrefix: string
}

/** Update input accepted by the aiopsAgents namespace; only present fields change. */
export interface AiopsAgentUpdateInput {
  readonly id: string
  readonly name?: string | undefined
  readonly role?: string | undefined
  readonly personaPrefix?: string | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed create/update/remove input; the field names the first offending member. */
    'aiops-agents/invalid': { readonly field: string }
    /** The addressed registry entry does not exist. */
    'aiops-agents/not-found': { readonly id: string }
    /** The preset cannot be composed or registered, e.g. the template preset is unavailable. */
    'aiops-agents/conflict': { readonly id: string }
  }
}
