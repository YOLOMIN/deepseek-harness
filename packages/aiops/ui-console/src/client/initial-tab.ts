/**
 * GAC2：平台入口页跳转指定页签的共享状态。
 * apply 启动时从 pf_tab Cookie 写入，控制台页面首渲染时一次性消费。
 * 独立成模块以避免 index.ts 与 AiopsConsolePage.tsx 之间的循环依赖。
 */

/** 模块级初始页签（null 表示无跳转指定）。 */
let initialTab: string | null = null

/** 写入初始页签（插件启动时调用）。 */
export function setInitialTab(tab: string): void {
  initialTab = tab
}

/** 读取并清除初始页签（一次性消费，供 AiopsConsolePage 初始化页签状态）。 */
export function consumeInitialTab(): string | null {
  const v = initialTab
  initialTab = null
  return v
}

/** 布局服务的最小结构（控制台只用到 selectPanel 关闭自身面板）。 */
interface LayoutLike {
  selectPanel(panelId: unknown): void
}

/** 模块级布局服务引用（插件激活时由 apply 写入）。 */
let layoutRef: LayoutLike | undefined

/** 写入布局服务引用（插件激活时调用）。 */
export function setLayoutService(layout: LayoutLike): void {
  layoutRef = layout
}

/** 关闭控制台主面板，回到会话主界面（"打开会话"跳转前调用）。 */
export function closeConsolePanel(): void {
  try { layoutRef?.selectPanel(null) } catch { /* 面板未就绪时忽略 */ }
}
