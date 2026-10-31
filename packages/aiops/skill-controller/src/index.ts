/**
 * Skill management for the operations console: lists the Nacos skill registry
 * through its Agent-Skills well-known discovery surface
 * (`/registry/{namespace}/.well-known/agent-skills/index.json`), merges each
 * row with the local install state under the DSH user skills root, and
 * installs (`{skillName}.zip` download → extract) / uninstalls (remove the
 * directory) through the `aiopsSkills` Remote namespace. The
 * skill-filesystem provider watches the root, so install state takes effect
 * without a restart.
 *
 * @module @gac2/dsh-aiops-skill-controller
 */

import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z as zod } from 'zod'
import type { AiopsSkillPage, AiopsSkillQuery, AiopsSkillRow } from './types.ts'

export type * from './types.ts'

/** Deployment choices for the skill controller. */
export interface Config {
  /** Skill registry origin (the AI-registry adaptor port), e.g. `http://192.168.10.95:9080`. */
  registryOrigin: string
  /** Registry namespace; the fork's skills live in `public`. */
  namespaceId: string
  /** Local skills root; defaults to the DSH user skills root. */
  skillsDir: string
  /** Registry request timeout in milliseconds. */
  requestTimeoutMs: number
}

/** Validated deployment choices. */
export const Config = z.object({
  registryOrigin: z.string().pattern(/^https?:\/\/[^\s]+$/u).required(),
  namespaceId: z.string().min(1).default('public'),
  skillsDir: z.string().min(1).default(resolve(homedir(), '.dsh', 'skills')),
  requestTimeoutMs: z.number().min(1000).max(60_000).default(15_000),
})

const querySchema = zod.object({
  keyword: zod.string().trim().optional(),
  page: zod.number().int().min(1),
  pageSize: zod.number().int().min(1).max(100),
})

const nameSchema = zod.object({ name: zod.string().min(1) })

function invalid(field: string, message: string): RemoteError {
  return new RemoteError('aiops-skills/invalid', message, { field })
}

function upstream(status: string, message: string): RemoteError {
  return new RemoteError('aiops-skills/upstream', message, { status })
}

/** One entry of the well-known agent-skills index; only the fields the console reads. */
interface RegistrySkillEntry {
  readonly name?: string
  readonly description?: string
  readonly version?: string
  readonly updatedAt?: string | number
  /** Declared text files of the skill (e.g. `["SKILL.md"]`). */
  readonly files?: readonly string[]
}

interface RegistryIndex {
  readonly skills?: readonly RegistrySkillEntry[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Skill registry + local install owner for the operations console. */
    aiopsSkillController: AiopsSkillController
  }
}

/**
 * Host owner of the `aiopsSkills` namespace. Registry reads hit the
 * well-known index on every query; install state is the local skills
 * directory contents.
 */
export class AiopsSkillController extends TypertRemoteService {
  static readonly inject: string[] = []

  private readonly config: Config

  constructor(owner: Context, config?: Config) {
    super(owner, 'aiopsSkillController', { namespace: 'aiopsSkills' })
    // Direct construction (tests) and config-less entries both skip loader validation; resolve defaults here.
    const [resolved] = z.resolve(config ?? {}, Config, {}) as [Config]
    this.config = resolved
  }

  /** Registry URL of the well-known agent-skills surface for the configured namespace. */
  private registryBase(): string {
    return `${this.config.registryOrigin}/registry/${encodeURIComponent(this.config.namespaceId)}/.well-known/agent-skills`
  }

  /** GET the well-known index and validate its envelope. */
  private async fetchIndex(): Promise<readonly RegistrySkillEntry[]> {
    let response: Response
    try {
      response = await fetch(`${this.registryBase()}/index.json`, { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error: unknown) {
      throw upstream('unreachable', `技能库不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw upstream(String(response.status), `技能库返回 HTTP ${response.status}`)
    const body = await response.json() as RegistryIndex
    return body.skills ?? []
  }

  /** Map one index entry into the wire row (install state filled by the caller). */
  private static rowOf(entry: RegistrySkillEntry, installed: boolean): AiopsSkillRow {
    const updatedAt = typeof entry.updatedAt === 'string' ? Date.parse(entry.updatedAt) : entry.updatedAt
    return {
      name: entry.name ?? 'unknown',
      version: entry.version ?? '-',
      description: entry.description ?? '',
      status: 'online',
      installed,
      ...(updatedAt === undefined || Number.isNaN(updatedAt) ? {} : { time: updatedAt }),
    }
  }

  /** Locally installed skill names = directories under the skills root. */
  private async installedNames(): Promise<Set<string>> {
    let entries
    try {
      entries = await readdir(this.config.skillsDir, { withFileTypes: true })
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Set()
      throw error
    }
    return new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  }

  /**
   * Query registry skills merged with local install state.
   * @param input - keyword filter plus paging.
   * @returns the filtered page with the installed count.
   */
  @Remote('list')
  async list(input: AiopsSkillQuery): Promise<AiopsSkillPage> {
    const parsed = querySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const keyword = parsed.data.keyword?.toLowerCase()
    const installed = await this.installedNames()
    const rows = (await this.fetchIndex())
      .map(entry => AiopsSkillController.rowOf(entry, installed.has(entry.name ?? '')))
      .filter(row => keyword === undefined || keyword === '' || `${row.name}\n${row.description}`.toLowerCase().includes(keyword))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: rows.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: rows.slice(start, start + parsed.data.pageSize),
      installedCount: rows.filter(row => row.installed).length,
    }
  }

  /**
   * Install one registry skill: fetch its declared files from the well-known
   * surface (`{name}/{filePath}`) and write them into the local skills root.
   * @param input - skill name.
   * @returns confirmation with the installed directory.
   */
  @Remote('install')
  async install(input: { readonly name: string }): Promise<{ readonly installed: true; readonly path: string }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'skill 名称无效')
    const name = parsed.data.name
    const index = await this.fetchIndex()
    const entry = index.find(row => row.name === name)
    if (entry === undefined) {
      throw new RemoteError('aiops-skills/not-found', `技能库中没有该 skill：${name}`, { name })
    }
    const files = entry.files !== undefined && entry.files.length > 0 ? entry.files : ['SKILL.md']
    const target = join(this.config.skillsDir, name)
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    try {
      for (const file of files) {
        const response = await this.fetchFile(name, file)
        const filePath = join(target, file)
        await mkdir(join(filePath, '..'), { recursive: true })
        await writeFile(filePath, response)
      }
    } catch (error: unknown) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
    return { installed: true, path: target }
  }

  /** GET one skill file from the well-known surface as text. */
  private async fetchFile(name: string, filePath: string): Promise<string> {
    let response: Response
    const url = `${this.registryBase()}/${encodeURIComponent(name)}/${filePath.split('/').map(encodeURIComponent).join('/')}`
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error: unknown) {
      throw upstream('unreachable', `技能库不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw upstream(String(response.status), `下载 ${filePath} 失败：HTTP ${response.status}`)
    return response.text()
  }

  /**
   * Uninstall one skill from the local skills root; the registry entry stays.
   * @param input - skill name.
   * @returns confirmation of the removal.
   */
  @Remote('uninstall')
  async uninstall(input: { readonly name: string }): Promise<{ readonly removed: true }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'skill 名称无效')
    const target = join(this.config.skillsDir, parsed.data.name)
    await rm(target, { recursive: true, force: true })
    return { removed: true }
  }
}

export default AiopsSkillController
