/**
 * 智能运维控制台插件，浏览器半：向侧边栏贡献"智能运维"入口及其打开的
 * 主栏控制台页面。页面为六模块管理原型（RAG / skills / 会话 / 日志 /
 * 记忆 / MCP），数据为内置示例。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { AiopsConsolePage } from './AiopsConsolePage.tsx'
import { AiopsPanelIcon } from './AiopsPanelIcon.tsx'
import { en, NS, zh, type AiopsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Aiops console copy. */
    'aiops': AiopsLocaleKey
  }
}

export { NS }

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'aiops' as MainPanelId

/** Services required by the sidebar registration and the page. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Contribute the aiops entry to the sidebar with the console page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-aiops: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({}),
  }, AiopsConsolePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, AiopsPanelIcon))
}
