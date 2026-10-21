/**
 * 智能运维控制台插件，Node 半。纯 UI 插件：空 apply 使插件出现在宿主
 * Loader 中；浏览器半经 exports["./client"] 投递，由 package.json 的
 * dsh.client 声明发现。
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply(): void {}
