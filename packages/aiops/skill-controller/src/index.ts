/**
 * Skill management for the operations console: lists the Nacos skill registry
 * through its Agent-Skills well-known discovery surface
 * (`/registry/{namespace}/.well-known/agent-skills/index.json`), merges each
 * row with the local install state under the DSH user skills root, and
 * installs (per-file download) / uninstalls (remove the directory) through
 * the `aiopsSkills` Remote namespace. The skill-filesystem provider watches
 * the root, so install state takes effect without a restart. The console-editable
 * settings (registry connection, discovery and invocation switches) persist in
 * `aiops-skill-registry.json` beside the skills root and win over the plugin Config.
 *
 * @module @gac2/dsh-aiops-skill-controller
 */

import { homedir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z as zod } from 'zod'
import type {
  AiopsSkillDetail, AiopsSkillPage, AiopsSkillQuery, AiopsSkillRow, AiopsSkillSettings,
} from './types.ts'

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

/** Persisted override: registry fields required, switches default on for files written before they existed. */
const settingsSchema = zod.object({
  registryOrigin: zod.string().regex(/^https?:\/\/\S+$/u, '注册中心地址必须是 http(s) URL'),
  namespaceId: zod.string().min(1),
  autoDiscover: zod.boolean().default(true),
  autoInvoke: zod.boolean().default(true),
})

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

/** Local placement of one installed skill: `live` = visible to agents, `quarantined` = downloaded but hidden. */
interface Placement {
  readonly live: ReadonlySet<string>
  readonly quarantined: ReadonlySet<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Skill registry + local install owner for the operations console. */
    aiopsSkillController: AiopsSkillController
  }
}

/**
 * Host owner of the `aiopsSkills` namespace. Registry reads hit the
 * well-known index on every query unless discovery is switched off; install
 * state is the union of the live skills root and the quarantine directory.
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

  /**
   * Settings currently in effect: the console-saved override file (beside the
   * skills root) wins over the plugin Config from cordis.yml.
   * @returns the merged settings with switches defaulted on.
   */
  private async effectiveSettings(): Promise<AiopsSkillSettings> {
    let raw: string | undefined
    try {
      raw = await readFile(this.overridePath(), 'utf8')
    } catch {
      // 覆盖文件缺失或不可读时回退插件配置
    }
    if (raw !== undefined) {
      try {
        const parsed = settingsSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return parsed.data
      } catch {
        // JSON 损坏等价于无覆盖，避免阻塞清单查询
      }
    }
    return {
      registryOrigin: this.config.registryOrigin,
      namespaceId: this.config.namespaceId,
      autoDiscover: true,
      autoInvoke: true,
    }
  }

  /** Path of the console-saved settings override, beside the skills root. */
  private overridePath(): string {
    return join(dirname(this.config.skillsDir), 'aiops-skill-registry.json')
  }

  /** Quarantine root: installed skills hidden from agents while invocation is switched off. */
  private quarantineDir(): string {
    return join(dirname(this.config.skillsDir), 'skills-quarantine')
  }

  /** Registry URL of the well-known agent-skills surface for the configured namespace. */
  private async registryBase(): Promise<string> {
    const settings = await this.effectiveSettings()
    return `${settings.registryOrigin}/registry/${encodeURIComponent(settings.namespaceId)}/.well-known/agent-skills`
  }

  /** GET the well-known index and validate its envelope. */
  private async fetchIndex(): Promise<readonly RegistrySkillEntry[]> {
    let response: Response
    try {
      response = await fetch(`${await this.registryBase()}/index.json`, { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error: unknown) {
      throw upstream('unreachable', `技能库不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw upstream(String(response.status), `技能库返回 HTTP ${response.status}`)
    const body = await response.json() as RegistryIndex
    return body.skills ?? []
  }

  /** Map one index entry into the wire row (install state filled by the caller). */
  private static rowOf(entry: RegistrySkillEntry, placement: Placement): AiopsSkillRow {
    const updatedAt = typeof entry.updatedAt === 'string' ? Date.parse(entry.updatedAt) : entry.updatedAt
    const name = entry.name ?? 'unknown'
    return {
      name,
      version: entry.version ?? '-',
      description: entry.description ?? '',
      status: 'online',
      installed: placement.live.has(name) || placement.quarantined.has(name),
      invocable: placement.live.has(name),
      ...(updatedAt === undefined || Number.isNaN(updatedAt) ? {} : { time: updatedAt }),
    }
  }

  /** Directory names directly under one root; a missing root reads as empty. */
  private static async dirNames(root: string): Promise<Set<string>> {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Set()
      throw error
    }
    return new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  }

  /** Snapshot of which skills sit in the live root versus quarantine. */
  private async placement(): Promise<Placement> {
    return {
      live: await AiopsSkillController.dirNames(this.config.skillsDir),
      quarantined: await AiopsSkillController.dirNames(this.quarantineDir()),
    }
  }

  /** Build a row for a locally installed skill when the registry is out of scope (discovery off). */
  private async localRow(name: string, invocable: boolean): Promise<AiopsSkillRow> {
    const dir = join(invocable ? this.config.skillsDir : this.quarantineDir(), name)
    let description = ''
    try {
      const head = await readFile(join(dir, 'SKILL.md'), 'utf8')
      description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? ''
    } catch {
      // SKILL.md 缺失时描述留空
    }
    return { name, version: '-', description, status: 'online', installed: true, invocable }
  }

  /**
   * Query registry skills merged with local install state. With discovery
   * switched off the registry is never contacted and only local skills list.
   * @param input - keyword filter plus paging.
   * @returns the filtered page with the installed count.
   */
  @Remote('list')
  async list(input: AiopsSkillQuery): Promise<AiopsSkillPage> {
    const parsed = querySchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `查询参数无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const keyword = parsed.data.keyword?.toLowerCase()
    const settings = await this.effectiveSettings()
    const placement = await this.placement()
    const rows = settings.autoDiscover
      ? (await this.fetchIndex()).map(entry => AiopsSkillController.rowOf(entry, placement))
      : await Promise.all([
        ...[...placement.live].map(async name => this.localRow(name, true)),
        ...[...placement.quarantined].map(async name => this.localRow(name, false)),
      ])
    const filtered = rows
      .filter(row => keyword === undefined || keyword === '' || `${row.name}\n${row.description}`.toLowerCase().includes(keyword))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    const start = (parsed.data.page - 1) * parsed.data.pageSize
    return {
      total: filtered.length,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      rows: filtered.slice(start, start + parsed.data.pageSize),
      installedCount: filtered.filter(row => row.installed).length,
    }
  }

  /**
   * Read one skill's detail for the console dialog: registry metadata merged
   * with local placement, falling back to local-only data when the registry
   * does not know the skill.
   * @param input - skill name.
   * @returns the row beside the declared file list and local directory.
   */
  @Remote('detail')
  async detail(input: { readonly name: string }): Promise<AiopsSkillDetail> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'skill 名称无效')
    const name = parsed.data.name
    const placement = await this.placement()
    const localPath = placement.live.has(name)
      ? join(this.config.skillsDir, name)
      : placement.quarantined.has(name)
        ? join(this.quarantineDir(), name)
        : undefined
    const entry = (await this.fetchIndex()).find(row => row.name === name)
    if (entry === undefined) {
      if (localPath === undefined) {
        throw new RemoteError('aiops-skills/not-found', `技能库与本机都没有该 skill：${name}`, { name })
      }
      return { row: await this.localRow(name, placement.live.has(name)), files: ['SKILL.md'], localPath }
    }
    return {
      row: AiopsSkillController.rowOf(entry, placement),
      files: entry.files !== undefined && entry.files.length > 0 ? entry.files : ['SKILL.md'],
      ...(localPath === undefined ? {} : { localPath }),
    }
  }

  /**
   * Install one registry skill: fetch its declared files from the well-known
   * surface (`{name}/{filePath}`) and write them into the live skills root —
   * or into quarantine while automatic invocation is switched off.
   * The wire name cannot be `install`/`remove`: RemoteNamespaceService owns
   * those prototype members and rejects conflicting method names at mount.
   * @param input - skill name.
   * @returns confirmation with the installed directory.
   */
  @Remote('installSkill')
  async installSkill(input: { readonly name: string }): Promise<{ readonly installed: true; readonly path: string }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'skill 名称无效')
    const name = parsed.data.name
    const index = await this.fetchIndex()
    const entry = index.find(row => row.name === name)
    if (entry === undefined) {
      throw new RemoteError('aiops-skills/not-found', `技能库中没有该 skill：${name}`, { name })
    }
    const settings = await this.effectiveSettings()
    const files = entry.files !== undefined && entry.files.length > 0 ? entry.files : ['SKILL.md']
    const target = join(settings.autoInvoke ? this.config.skillsDir : this.quarantineDir(), name)
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
    const url = `${await this.registryBase()}/${encodeURIComponent(name)}/${filePath.split('/').map(encodeURIComponent).join('/')}`
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error: unknown) {
      throw upstream('unreachable', `技能库不可达：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw upstream(String(response.status), `下载 ${filePath} 失败：HTTP ${response.status}`)
    return response.text()
  }

  /**
   * Uninstall one skill from the live root and quarantine; the registry entry stays.
   * @param input - skill name.
   * @returns confirmation of the removal.
   */
  @Remote('uninstallSkill')
  async uninstallSkill(input: { readonly name: string }): Promise<{ readonly removed: true }> {
    const parsed = nameSchema.safeParse(input)
    if (!parsed.success) throw invalid('name', 'skill 名称无效')
    await rm(join(this.config.skillsDir, parsed.data.name), { recursive: true, force: true })
    await rm(join(this.quarantineDir(), parsed.data.name), { recursive: true, force: true })
    return { removed: true }
  }

  /**
   * Read the settings the console shows and the queries use.
   * @returns the effective registry connection plus discovery/invocation switches.
   */
  @Remote('getSettings')
  async getSettings(): Promise<AiopsSkillSettings> {
    return this.effectiveSettings()
  }

  /**
   * Persist the settings override beside the skills root; the next query reads
   * it. Flipping the invocation switch migrates every installed skill between
   * the live root and quarantine, so agents gain or lose them without a restart.
   * @param input - full settings (every field required).
   * @returns the persisted settings.
   */
  @Remote('saveSettings')
  async saveSettings(input: AiopsSkillSettings): Promise<AiopsSkillSettings> {
    const parsed = settingsSchema.safeParse(input)
    if (!parsed.success) throw invalid('input', `技能配置无效：${parsed.error.issues[0]?.message ?? 'unknown'}`)
    const previous = await this.effectiveSettings()
    await mkdir(dirname(this.overridePath()), { recursive: true })
    await writeFile(this.overridePath(), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
    if (previous.autoInvoke !== parsed.data.autoInvoke) {
      await this.migrateAll(parsed.data.autoInvoke)
    }
    return parsed.data
  }

  /** Move every installed skill into the live root (invocable) or quarantine (hidden). */
  private async migrateAll(autoInvoke: boolean): Promise<void> {
    const from = autoInvoke ? this.quarantineDir() : this.config.skillsDir
    const to = autoInvoke ? this.config.skillsDir : this.quarantineDir()
    for (const name of await AiopsSkillController.dirNames(from)) {
      await mkdir(to, { recursive: true })
      await rename(join(from, name), join(to, name))
    }
  }
}

export default AiopsSkillController
