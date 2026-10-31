/**
 * Durable registry file of console-created AIOps agents.
 *
 * The file is the single writer-owned source of truth for dynamic agents; writes
 * are atomic (sibling temporary file, then rename) and every read revalidates
 * the full document at the durable boundary.
 *
 * @module @gac2/dsh-aiops-agent-controller/store
 */

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AiopsAgentUpdateInput } from './types.ts'

/** One persisted agent definition. */
export interface AgentDefinition {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly personaPrefix: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Deployment-seeded default agent: editable but never destroyable. */
  readonly builtin?: boolean | undefined
}


const definitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  personaPrefix: z.string().min(1),
  builtin: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

const documentSchema = z.object({ agents: z.array(definitionSchema) })

/**
 * Read-modify-write owner of the registry JSON file. Instances are cheap but
 * single-process: the owning controller serializes mutations through its calls.
 */
export class AgentStore {
  private definitions: AgentDefinition[] | undefined

  /**
   * @param path - absolute registry JSON path; the parent directory is created on first write.
   */
  constructor(private readonly path: string) {}

  /**
   * Whether the registry file exists; an absent file triggers first-boot seeding.
   * @returns true when the file is present (regardless of content).
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.path)
      return true
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Load and cache every stored definition; a missing file means an empty registry.
   * @returns stored definitions in file order.
   * @throws when the file exists but does not parse or fails document validation.
   */
  async load(): Promise<readonly AgentDefinition[]> {
    if (this.definitions !== undefined) return this.definitions
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.definitions = []
        return this.definitions
      }
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    this.definitions = documentSchema.parse(parsed).agents
    return this.definitions
  }

  /**
   * Insert one definition and persist; ids are unique across the registry.
   * @param definition - complete new definition.
   * @throws Error when the id already exists.
   */
  async insert(definition: AgentDefinition): Promise<void> {
    const current = await this.load()
    if (current.some(row => row.id === definition.id)) throw new Error(`智能体已存在：${definition.id}`)
    this.definitions = [...current, definition]
    await this.persist()
  }

  /**
   * Apply one update patch and persist.
   * @param id - target definition.
   * @param patch - fields to replace; only present members change.
   * @returns the updated definition.
   * @throws Error when the id is unknown.
   */
  async update(id: string, patch: Omit<AiopsAgentUpdateInput, 'id'>): Promise<AgentDefinition> {
    const current = await this.load()
    const index = current.findIndex(row => row.id === id)
    const previous = index < 0 ? undefined : current[index]
    if (previous === undefined) throw new Error(`智能体不存在：${id}`)
    const next: AgentDefinition = {
      ...previous,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.personaPrefix === undefined ? {} : { personaPrefix: patch.personaPrefix }),
      updatedAt: Date.now(),
    }
    this.definitions = current.map(row => (row.id === id ? next : row))
    await this.persist()
    return next
  }

  /**
   * Delete one definition and persist.
   * @param id - target definition.
   * @throws Error when the id is unknown.
   */
  async remove(id: string): Promise<void> {
    const current = await this.load()
    if (!current.some(row => row.id === id)) throw new Error(`智能体不存在：${id}`)
    this.definitions = current.filter(row => row.id !== id)
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (this.definitions === undefined) throw new Error('registry not loaded')
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify({ agents: this.definitions }, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}
