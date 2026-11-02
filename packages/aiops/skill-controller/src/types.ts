/**
 * Wire vocabulary of the aiopsSkills Remote namespace: registry skill rows,
 * paged listing, install/uninstall actions, and the failure taxonomy.
 *
 * @module @gac2/dsh-aiops-skill-controller/types
 */

/** Registry-side lifecycle status of one skill version, mirrored from Nacos. */
export type AiopsSkillStatus = 'editing' | 'reviewing' | 'online' | 'offline'

/** One skill row merging registry metadata with local install state. */
export interface AiopsSkillRow {
  /** Skill name (registry identity). */
  readonly name: string
  /** Latest online (or otherwise newest) version label. */
  readonly version: string
  readonly description: string
  /** Registry lifecycle status of that version. */
  readonly status: AiopsSkillStatus
  /** Whether the skill is installed into the local DSH skills root. */
  readonly installed: boolean
  /** Registry update time in epoch milliseconds, when known. */
  readonly time?: number | undefined
}

/** Paged registry query accepted by the aiopsSkills namespace. */
export interface AiopsSkillQuery {
  /** Case-insensitive substring matched against name and description. */
  readonly keyword?: string | undefined
  /** 1-based page number. */
  readonly page: number
  /** Page size, capped by the controller schema. */
  readonly pageSize: number
}

/** One page of skill rows. */
export interface AiopsSkillPage {
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly rows: readonly AiopsSkillRow[]
  /** Count of rows currently installed locally. */
  readonly installedCount: number
}

/** Registry connection settings editable from the console, persisted as an override file. */
export interface AiopsSkillRegistryConfig {
  /** Skill registry origin (the AI-registry adaptor port), e.g. `http://192.168.10.95:9080`. */
  readonly registryOrigin: string
  /** Registry namespace; the fork's skills live in `public`. */
  readonly namespaceId: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Malformed input; the field names the first offending member. */
    'aiops-skills/invalid': { readonly field: string }
    /** The registry has no such skill. */
    'aiops-skills/not-found': { readonly name: string }
    /** The Nacos registry is unreachable or answered with an error. */
    'aiops-skills/upstream': { readonly status: string }
  }
}
