/** `aiops` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'aiops'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel': '智能运维控制台',
  'title': '智能运维控制台',
} as const

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'panel': 'AI Ops Console',
  'title': 'AI Ops Console',
}

export type AiopsLocaleKey = keyof typeof zh
