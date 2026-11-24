# dsh-markdown-session

DSH Web GUI 插件开发工作区。**仓库根即工作区**，插件本体位于子目录。

A workspace for developing a DSH Web GUI plugin. **The repository root is the workspace**; the plugin itself lives in a subdirectory.

## 包含什么 / What's inside

| 路径 Path | 说明 Description |
| --- | --- |
| [`plugins/dsh-markdown-session/`](plugins/dsh-markdown-session/) | 插件本体：会话消息 Markdown + 白名单 HTML 渲染、XSS 防护、聊天气泡 |
| `.dsh-graph/` | 本工作区的目标看板数据，由 dsh-graph 插件管理，**不入 git** |

## 插件：dsh-markdown-session

把 DSH Web GUI 的会话消息渲染成聊天 App 的样子：发送与接收的消息都按 Markdown 渲染，支持受限的内嵌 HTML，并对所有消息内容做 XSS 防护。

Renders DSH conversation messages as chat-app bubbles: both user-sent and assistant messages get Markdown, a whitelisted subset of inline HTML, and XSS hardening.

- **用户消息（发送侧）**：接管 `conversation.user.text.node` 的 `text` 子槽，marked(GFM) 渲染；代码块等宽、表格边框斑马纹、宽表横向滚动。
- **助手消息（接收侧）**：不接管 React 渲染树，保留原生 GFM / 表格 / KaTeX / Shiki；用 DOM 后处理把显示为字面文本的白名单 HTML（`<details>`、`<kbd>`、`<table>`…）替换成清洗后的真实元素。
- **XSS 防护**：所有消息内容视为不可信。DOMPurify 标签 + 属性 + URI 白名单，链接补 `rel="noopener noreferrer"`，没有 sanitizer 时失败关闭（回退为转义纯文本）。
- **聊天气泡**：用户右对齐、助手左对齐；气泡锚在消息根，流式与历史中间 step 同样有气泡；只有折叠思考 / 纯 tool-call 的节点不出空气泡。
- **可逆卸载**：禁用插件后移除样式、根属性、MutationObserver，并把已替换的 HTML 还原成字面文本。

- 详细说明 / Full docs：[`plugins/dsh-markdown-session/README.md`](plugins/dsh-markdown-session/README.md)
- 版本：`0.1.0`（当前仅在本地 web profile 使用，尚未发布 npm）

### 安装 / Install

在 DSH 会话里 / inside a DSH session：

```
plugin_manager action=install_bundle target=<绝对路径>/plugins/dsh-markdown-session
```

或用 CLI 装包：

```bash
dsh plugin --profile web add link:/absolute/path/to/plugins/dsh-markdown-session
```

装完刷新页面即可；禁用插件后页面恢复原样。

## 开发 / Development

```bash
cd plugins/dsh-markdown-session
npm run check   # 语法检查 / syntax check
npm test        # 构建 + node:test（单元 + 无头 Chrome E2E）
```

改完 client 半区代码后重跑 `npm run build`（`npm test` 会自动构建），然后刷新页面。

浏览器运行时零外部依赖：marked 与 DOMPurify 在构建时内联进 `client.js`（许可证随包保留在 `vendor/`），运行时只有 `react` 走 DSH 共享静态模块。

## 目标看板

本工作区用 dsh-graph 管理目标与版本，数据在 `.dsh-graph/`（不入 git）。当前版本 `v0.1.0` 下包含已交付目标 `g-001`。

## 许可证 / License

[MIT](LICENSE) © 2026 ricardo
