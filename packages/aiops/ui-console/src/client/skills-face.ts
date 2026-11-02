/**
 * skills 管理的浏览器数据面：经 ctx.remote.aiopsSkills 查询 Nacos 技能库清单、
 * 安装/卸载本地 skill（写入/移出 DSH 用户技能根目录，skill-filesystem 热扫描即时生效）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@gac2/dsh-aiops-skill-controller/remote'
import type { AiopsSkillPage, AiopsSkillQuery, AiopsSkillRegistryConfig } from '@gac2/dsh-aiops-skill-controller/types'

/** Skills tab data and action surface injected by the plugin apply closure. */
export interface AiopsSkillsFace {
  /** Run one filtered, paged registry query merged with local install state. */
  listSkills: (input: AiopsSkillQuery) => Promise<AiopsSkillPage>
  /** Install one registry skill into the local skills root. */
  installSkill: (name: string) => Promise<void>
  /** Uninstall one skill from the local skills root. */
  uninstallSkill: (name: string) => Promise<void>
  /** Read the effective registry connection (console override or plugin config). */
  getRegistryConfig: () => Promise<AiopsSkillRegistryConfig>
  /** Persist a registry connection override; later queries use it immediately. */
  saveRegistryConfig: (input: AiopsSkillRegistryConfig) => Promise<AiopsSkillRegistryConfig>
}

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Bind the aiopsSkills namespace into one plain-callback face.
 * @param ctx - the browser plugin context.
 * @returns the face handed to the console page through the slots inject channel.
 */
export function createAiopsSkillsFace(ctx: ClientContext): AiopsSkillsFace {
  return {
    listSkills: async input => unwrap(await ctx.remote.aiopsSkills.list(input)),
    installSkill: async (name) => { unwrap(await ctx.remote.aiopsSkills.installSkill({ name })) },
    uninstallSkill: async (name) => { unwrap(await ctx.remote.aiopsSkills.uninstallSkill({ name })) },
    getRegistryConfig: async () => unwrap(await ctx.remote.aiopsSkills.getRegistryConfig()),
    saveRegistryConfig: async input => unwrap(await ctx.remote.aiopsSkills.saveRegistryConfig(input)),
  }
}
