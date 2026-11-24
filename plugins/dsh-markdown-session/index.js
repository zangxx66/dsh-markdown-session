/**
 * dsh-markdown-session — 宿主半边。
 *
 * 本插件的能力全部在浏览器（client.js）：用户消息渲染器注册与助手消息 DOM 后处理。
 * 宿主侧不需要工具、服务、路由或持久数据，因此这里只保留一个空 apply，
 * 让 plugin_manager / loader 能把它当作合法 cordis 插件安装与启停。
 */
export const name = 'dsh-markdown-session'

/** 不等待任何宿主服务（能力全在 Web 半区）。 */
export const inject = []

/** 宿主侧无行为；保留函数体让插件生命周期完整。 */
export function apply() {}
