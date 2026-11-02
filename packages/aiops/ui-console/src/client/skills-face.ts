/**
 * skills 管理的浏览器数据面：经 ctx.remote.aiopsSkills 查询 Nacos 技能库清单、
 * 查看技能详情、安装/卸载本地 skill（写入/移出 DSH 用户技能根目录，skill-filesystem
 * 热扫描即时生效），并读写技能库对接与发现/调用开关设置。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@gac2/dsh-aiops-skill-controller/remote'
import type { AiopsSkillDetail, AiopsSkillPage, AiopsSkillQuery, AiopsSkillSettings } from '@gac2/dsh-aiops-skill-controller/types'

/** Skills tab data and action surface injected by the plugin apply closure. */
export interface AiopsSkillsFace {
  /** Run one filtered, paged registry query merged with local install state. */
  listSkills: (input: AiopsSkillQuery) => Promise<AiopsSkillPage>
  /** Read one skill's registry metadata, declared files, and local placement. */
  getSkillDetail: (name: string) => Promise<AiopsSkillDetail>
  /** Install one registry skill into the local skills root (or quarantine while invocation is off). */
  installSkill: (name: string) => Promise<void>
  /** Uninstall one skill from the local skills root and quarantine. */
  uninstallSkill: (name: string) => Promise<void>
  /** Read the effective settings (console override or plugin config). */
  getSettings: () => Promise<AiopsSkillSettings>
  /** Persist the settings override; later queries and installs use it immediately. */
  saveSettings: (input: AiopsSkillSettings) => Promise<AiopsSkillSettings>
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
    getSkillDetail: async name => unwrap(await ctx.remote.aiopsSkills.detail({ name })),
    installSkill: async (name) => { unwrap(await ctx.remote.aiopsSkills.installSkill({ name })) },
    uninstallSkill: async (name) => { unwrap(await ctx.remote.aiopsSkills.uninstallSkill({ name })) },
    getSettings: async () => unwrap(await ctx.remote.aiopsSkills.getSettings()),
    saveSettings: async input => unwrap(await ctx.remote.aiopsSkills.saveSettings(input)),
  }
}
