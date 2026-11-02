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
  /** Whether the skill is downloaded onto this machine (live root or quarantine). */
  readonly installed: boolean
  /** Whether the installed skill is visible to agents (live skills root, not quarantined). */
  readonly invocable: boolean
  /** Registry update time in epoch milliseconds, when known. */
  readonly time?: number | undefined
}

/** Full skill detail for the in-place dialog: registry metadata plus local placement. */
export interface AiopsSkillDetail {
  readonly row: AiopsSkillRow
  /** Declared text files of the skill (e.g. `["SKILL.md"]`). */
  readonly files: readonly string[]
  /** Local directory holding the skill, when installed. */
  readonly localPath?: string | undefined
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

/** Console-editable skill subsystem settings: registry connection plus discovery/invocation switches. */
export interface AiopsSkillSettings extends AiopsSkillRegistryConfig {
  /** 自动发现：关闭后清单不再访问技能库，只列本机已安装技能。 */
  readonly autoDiscover: boolean
  /** 自动调用：关闭后安装的技能落入隔离目录，对智能体不可见。 */
  readonly autoInvoke: boolean
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
