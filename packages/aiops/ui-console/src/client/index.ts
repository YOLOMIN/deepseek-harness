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
import { setInitialTab, setLayoutService } from './initial-tab.ts'
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
  // GAC2：布局服务写入模块级引用，供控制台页面"打开会话"时关闭自身面板回到会话主界面。
  setLayoutService(ctx.layout)
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
  // GAC2：平台入口页模块卡片跳转指定页签——账号认证中继经 pf_tab Cookie 携带目标页签，
  // 面板注册完成后延迟读取并清除 Cookie，打开控制台面板（会话管理跳转为会话主界面，不打开面板）。
  ctx.effect(() => {
    const m = /(?:^|;\s*)pf_tab=([a-z]+)/.exec(document.cookie)
    if (!m) return
    document.cookie = 'pf_tab=; Path=/; Max-Age=0'
    const tab = m[1]
    if (tab === 'sessions') return
    setInitialTab(tab)
    setTimeout(() => {
      try { ctx.layout.selectPanel(PANEL_ID) } catch { /* 面板未就绪时忽略，用户可手动打开 */ }
    }, 0)
  }, 'ui-aiops: initial tab')
}
