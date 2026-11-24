/**
 * dsh-markdown-session — 纯逻辑单测（node:test，零依赖）。
 *
 * 覆盖：
 *  - 用户消息 marked(GFM) 渲染结构（标题/列表/强调/行内码/围栏码/引用/表格/链接/删除线/分割线）
 *  - 渲染→清洗管线的顺序与「没有 sanitizer 时回退纯文本」的失败关闭
 *  - sanitizer 配置（白名单标签/属性、禁项、URI 正则、data-attr 关闭）
 *  - href / img src 策略与脏输入
 *  - apply 的生命周期（槽注册 key/priority、样式与根属性、locale 字典、可逆卸载）
 *  - 组件输出（dangerouslySetInnerHTML、预览降级）
 *  - 生成产物 client.js 的形态与样式约束（无 transform、不碰工具行）
 *
 * 真实 DOMPurify 的 XSS 负向断言在 test/browser.test.mjs（无头 Chrome 真浏览器）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const createMarkdownSession = require(join(ROOT, 'lib/markdown-session.cjs'))
const marked = require(join(ROOT, 'vendor/marked.umd.cjs'))

/* ------------------------------------------------------------------ */
/* 测试替身                                                             */
/* ------------------------------------------------------------------ */

/** 记录调用的 sanitizer 替身：node 环境没有 DOM，DOMPurify 无法运行，这里只验证配置与顺序。 */
function createFakePurifier() {
  const calls = []
  return {
    calls,
    addHook(name, fn) { calls.push({ hook: name, fn }) },
    removeHook(name) { calls.push({ removeHook: name }) },
    sanitize(html, config) {
      calls.push({ html, config })
      return String(html)
    },
  }
}

function createFakeReact() {
  const react = {
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props, { children }), key: props && props.key }
    },
    useMemo(factory) { return factory() },
    useRef(value) { return { current: value } },
    useState(value) { return [value, () => {}] },
    useEffect() {},
  }
  return react
}

/** 极简文档替身：只实现 apply 用到的 DOM 面（不是浏览器模拟器）。 */
function createFakeDocument() {
  const attrs = new Map()
  const headChildren = []
  const documentElement = {
    lang: 'zh-CN',
    setAttribute(name, value) { attrs.set(name, value) },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    removeAttribute(name) { attrs.delete(name) },
    hasAttribute(name) { return attrs.has(name) },
  }
  const body = {}
  const document = {
    documentElement,
    body,
    attrs,
    headChildren,
    head: {
      appendChild(node) { headChildren.push(node); node.parentNode = document.head; return node },
      removeChild(node) { const index = headChildren.indexOf(node); if (index >= 0) headChildren.splice(index, 1); node.parentNode = null },
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: new Map(),
        parentNode: null,
        textContent: '',
        setAttribute(name, value) { this.attributes.set(name, String(value)) },
        getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null },
        hasAttribute(name) { return this.attributes.has(name) },
        removeAttribute(name) { this.attributes.delete(name) },
      }
    },
    createComment(text) { return { nodeType: 8, nodeValue: text, parentNode: null } },
    querySelectorAll() { return [] },
  }
  return document
}

function createFakeObserver() {
  const observers = []
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.observing = null; this.disconnected = false; observers.push(this) }
    observe(target, options) { this.observing = { target, options } }
    disconnect() { this.disconnected = true }
  }
  return { FakeMutationObserver, observers }
}

function createFakeContext() {
  const registrations = []
  const effectDisposers = []
  const slotDisposers = []
  const localeCalls = []
  const ctx = {
    registrations,
    effectDisposers,
    localeCalls,
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.user.text.node')
        const disposer = callback()
        const off = () => disposer()
        slotDisposers.push(off)
        return off
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => { registrations.pop() }
      },
    },
    effect(fn) {
      const disposer = fn()
      effectDisposers.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get(name) {
      if (name === 'locale') {
        return { register(ns, dictionaries) { localeCalls.push({ ns, dictionaries }); return () => {} } }
      }
      return undefined
    },
  }
  return ctx
}

function createSession(overrides = {}) {
  const document = overrides.document || createFakeDocument()
  const purifier = overrides.purifier || createFakePurifier()
  const observer = createFakeObserver()
  const session = createMarkdownSession({
    React: overrides.React === null ? null : (overrides.React || createFakeReact()),
    marked: overrides.marked === null ? null : (overrides.marked || marked),
    DOMPurify: overrides.purifier === null ? null : purifier,
    document,
    window: overrides.window || { document, getComputedStyle: () => ({ textOverflow: 'clip' }), console },
    MutationObserver: observer.FakeMutationObserver,
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  return { session, document, purifier, observer }
}

/* ------------------------------------------------------------------ */
/* 用户消息 Markdown 渲染                                              */
/* ------------------------------------------------------------------ */

test('renderUserMarkdown 覆盖 GFM 基础语法', () => {
  const { session } = createSession({ purifier: null })
  // 无 purifier 会回退纯文本；这里改用 passthrough sanitizer 的实例
  const passthrough = createSession()
  const html = passthrough.session.renderUserMarkdown([
    '# 一级标题',
    '',
    '**粗体** 与 *斜体* 与 ~~删除线~~',
    '',
    '- 项目一',
    '- 项目二',
    '',
    '1. 有序一',
    '2. 有序二',
    '',
    '> 引用行',
    '',
    '`行内代码`',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '[链接](https://example.com)',
    '',
    '---',
  ].join('\n'))
  for (const snippet of [
    '<h1', '<strong>', '<em>', '<del>', '<ul>', '<li>', '<ol>', '<blockquote>',
    '<code>', '<pre>', '<table>', '<thead>', '<th', '<td', '<a href="https://example.com"',
    '<hr', '列A',
  ]) {
    assert.ok(html.includes(snippet), `缺少片段 ${snippet}`)
  }
  // 无 purifier 的会话必须失败关闭：不输出 tags，只输出转义文本
  assert.equal(session.renderUserMarkdown('**x**').includes('<strong>'), false)
  assert.ok(session.renderUserMarkdown('<b>x</b>').includes('&lt;b&gt;'))
})

test('渲染→清洗顺序：sanitize 收到 marked 产物，返回值即插入内容', () => {
  const fakeMarked = { parse: () => '<p>RENDERED</p>' }
  const { session, purifier } = createSession({ marked: fakeMarked })
  session.clearCache()
  const html = session.renderUserMarkdown('任意输入')
  assert.equal(html, '<p>RENDERED</p>')
  const sanitizeCall = purifier.calls.find((call) => call.html !== undefined)
  assert.ok(sanitizeCall, 'sanitizer 必须被调用')
  assert.equal(sanitizeCall.html, '<p>RENDERED</p>')
  assert.equal(sanitizeCall.config.ALLOW_DATA_ATTR, false)
})

test('sanitizer 配置是强白名单并显式禁掉危险面', () => {
  const { session, purifier } = createSession()
  session.clearCache()
  session.renderUserMarkdown('**x**')
  const config = purifier.calls.find((call) => call.html !== undefined).config
  for (const dangerous of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math']) {
    assert.ok(config.FORBID_TAGS.includes(dangerous), `FORBID_TAGS 缺少 ${dangerous}`)
    assert.equal(config.ALLOWED_TAGS.includes(dangerous), false, `ALLOWED_TAGS 不应包含 ${dangerous}`)
  }
  for (const attr of ['style', 'srcset', 'srcdoc', 'formaction', 'xlink:href']) {
    assert.ok(config.FORBID_ATTR.includes(attr), `FORBID_ATTR 缺少 ${attr}`)
  }
  assert.equal(config.ALLOWED_ATTR.some((name) => name.startsWith('on')), false)
  assert.equal(config.ALLOW_DATA_ATTR, false)
  assert.equal(config.ALLOW_ARIA_ATTR, false)
  assert.equal(config.ALLOWED_URI_REGEXP, session.__internals.SAFE_URI_REGEXP)
})

/* ------------------------------------------------------------------ */
/* URL 策略                                                            */
/* ------------------------------------------------------------------ */

test('isSafeHref 放行 http(s)/mailto/相对/锚点，拒绝危险 scheme 与混淆写法', () => {
  const { session } = createSession()
  for (const safe of [
    'https://example.com/a?b=1', 'http://example.com', 'mailto:a@example.com',
    '#frag', '/abs/path', './rel', 'rel/path', '?q=1', '//cdn.example.com/a.png',
  ]) {
    assert.equal(session.isSafeHref(safe), true, `应放行 ${safe}`)
  }
  for (const unsafe of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)',
    'java\tscript:alert(1)', ' javascript:alert(1)', 'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'blob:https://x/y',
    'tel:+123', 'ftp://x', '',
  ]) {
    assert.equal(session.isSafeHref(unsafe), false, `应拒绝 ${JSON.stringify(unsafe)}`)
  }
})

test('isSafeImageSrc 仅放行 http(s)/相对/data:image 位图', () => {
  const { session } = createSession()
  for (const safe of [
    'https://example.com/a.png', 'http://example.com/a.jpg', '/a.png', './a.png',
    'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/4AAQ',
  ]) {
    assert.equal(session.isSafeImageSrc(safe), true, `应放行 ${safe}`)
  }
  for (const unsafe of [
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)', 'file:///a.png', 'blob:https://x/y', '',
  ]) {
    assert.equal(session.isSafeImageSrc(unsafe), false, `应拒绝 ${unsafe}`)
  }
})

/* ------------------------------------------------------------------ */
/* 字面 HTML 检测                                                       */
/* ------------------------------------------------------------------ */

test('hasWhitelistTag 只对白名单标签返回 true，普通文本/非白名单标签不受影响', () => {
  const { session } = createSession()
  assert.equal(session.hasWhitelistTag('<b>粗</b>'), true)
  assert.equal(session.hasWhitelistTag('文字 <details open>细节</details>'), true)
  assert.equal(session.hasWhitelistTag('<TABLE><tr><td>x</td></tr></TABLE>'), true)
  assert.equal(session.hasWhitelistTag('<script>alert(1)</script>'), false)
  assert.equal(session.hasWhitelistTag('<custom-tag>x</custom-tag>'), false)
  assert.equal(session.hasWhitelistTag('1 < 2 && 3 > 2'), false)
  assert.equal(session.hasWhitelistTag('没有标签'), false)
  assert.equal(session.hasWhitelistTag(''), false)
})

test('isBalancedHtml 用于判断跨节点 HTML 是否需要拼接/放弃', () => {
  const { session } = createSession()
  assert.equal(session.isBalancedHtml('<details><summary>标题</summary>正文'), false, '未闭合 details 应判为不平衡')
  assert.equal(session.isBalancedHtml('<details><summary>标题</summary>正文</details>'), true)
  assert.equal(session.isBalancedHtml('<kbd>Ctrl</kbd>+<kbd>V</kbd>'), true)
  assert.equal(session.isBalancedHtml('<br><img src="x"><hr>'), true, 'void 标签不应被当成未闭合')
  assert.equal(session.isBalancedHtml('<b>未闭合'), false)
  assert.equal(session.isBalancedHtml('纯文本 1 < 2 与 3 > 2'), true)
  assert.equal(session.isBalancedHtml('</summary>游离闭合'), true, '游离闭合标签不产生结构')
})

test('escapeHtml 覆盖五种字符', () => {
  const { session } = createSession()
  assert.equal(session.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

/* ------------------------------------------------------------------ */
/* apply 生命周期                                                      */
/* ------------------------------------------------------------------ */

test('apply 注册 key=text 且 priority 低于上游 100、注入样式与根属性', () => {
  const { session, document, observer } = createSession()
  const ctx = createFakeContext()
  session.apply(ctx)

  assert.equal(document.attrs.get('data-dsh-md-session'), 'on')
  const style = document.headChildren.find((node) => node.tagName === 'STYLE')
  assert.ok(style, '必须注入样式元素')
  assert.equal(style.getAttribute('data-plugin'), 'dsh-markdown-session')
  assert.ok(style.textContent.includes('data-chat-flow-kind="assistant-step"'))
  assert.ok(style.textContent.includes('[data-message-bubble]'))
  assert.ok(style.textContent.includes('md-table-wide'))

  assert.equal(ctx.registrations.length, 1)
  const { options, component } = ctx.registrations[0]
  assert.equal(options.name, 'conversation.user.text.node')
  assert.equal(options.key, 'text')
  assert.equal(options.priority, session.SHADOW_PRIORITY)
  assert.ok(options.priority < 100, 'priority 必须低于 ui-conversation 的 100 才能 shadow')
  assert.equal(typeof component, 'function')

  assert.equal(ctx.localeCalls.length, 1)
  assert.equal(ctx.localeCalls[0].ns, 'dsh-markdown-session')
  assert.ok(ctx.localeCalls[0].dictionaries.zh && ctx.localeCalls[0].dictionaries.en)

  assert.equal(observer.observers.length, 1)
  assert.equal(observer.observers[0].disconnected, false)
  assert.equal(observer.observers[0].observing.options.subtree, true)
})

test('apply 卸载完全可逆：样式/根属性/监听/槽注册全部还原', () => {
  const { session, document, observer } = createSession()
  const ctx = createFakeContext()
  const dispose = session.apply(ctx)
  dispose()
  dispose() // 幂等

  assert.equal(document.attrs.has('data-dsh-md-session'), false)
  assert.equal(document.headChildren.length, 0)
  assert.equal(observer.observers[0].disconnected, true)
  assert.equal(ctx.registrations.length, 0)
})

test('无 slots 的上下文不抛错，返回幂等 dispose', () => {
  const { session, document } = createSession()
  const dispose = session.apply({})
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(document.attrs.has('data-dsh-md-session'), false)
})

test('气泡锚点是消息节点根：流式与历史 step 都有外壳，且不向行容器注入无效布局', () => {
  const { session } = createSession()
  const css = session.CSS
  const scope = '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) > [data-slot="conversation.chat.node"] > div'
  const rules = css.split('\n')
  // 布局稳定化：几何（padding/border 宽度/width/圆角）恒定在消息根上，与内容状态无关。
  const geometryRule = rules.find((line) => line.includes(scope + '{'))
  assert.ok(geometryRule, '找不到恒定几何规则')
  assert.equal(geometryRule.includes(':has('), false, '几何规则不得依赖内容状态（:has 会让流式行高突变）')
  for (const declaration of ['box-sizing:border-box', 'width:fit-content', 'max-width:', 'padding:12px 16px', 'border:1px solid', 'border-radius:']) {
    assert.ok(geometryRule.includes(declaration), '恒定几何缺少 ' + declaration)
  }
  assert.ok(geometryRule.includes('[data-chat-group-part="reasoning"]'), '几何规则未排除 reasoning 分区行')
  // 视觉显形只看「body 里有任意可见内容」（含可见 reasoning / 过程包装），并且只改视觉属性。
  const visualRule = rules.find((line) => line.includes(scope + ':has('))
  assert.ok(visualRule, '找不到气泡视觉规则')
  assert.equal(visualRule.includes('[data-text-interaction-source]'), false, '气泡规则不得依赖 settled 属性')
  assert.ok(visualRule.includes(':has(> div > *:not([hidden]):not(:empty))'), '气泡缺少「有任意可见内容」条件')
  assert.ok(visualRule.includes('background:') && visualRule.includes('border-color:'), '气泡缺少背景/边框色')
  for (const pureVisual of ['padding:', 'box-sizing', 'border-width', 'border:1px', 'width:fit-content', 'max-width:', 'border-radius:']) {
    assert.equal(visualRule.includes(pureVisual), false, '视觉规则混入了会改变几何的 ' + pureVisual)
  }
  assert.ok(visualRule.includes(':not([data-chat-group-part="reasoning"])'), '视觉规则未排除 reasoning 分区行')
  assert.equal(css.includes(':has(:has'), false, '不得嵌套 :has（Chrome 会判整条非法）')
  // 行容器不是 flex 容器：不得对 [data-chat-flow-kind] 注入布局属性。
  assert.equal(css.includes('justify-content'), false, '不得向行容器注入 justify-content')
  assert.equal(/\[data-chat-flow-kind="(user|assistant-step)"\]\{/.test(css), false, '不得直接改行容器布局')
  // 后处理/表格美化仍按 settled 属性（正确，保持）。
  assert.ok(css.includes('[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]'))
})

test('样式不含 transform / 不针对工具卡与思考块，避免破坏 sticky banner 与既有 UI', () => {
  const { session } = createSession()
  const css = session.CSS
  assert.equal(/(^|[;{])\s*transform\s*:/.test(css), false, '不得设置 transform（会破坏 sticky 代码 banner）')
  assert.equal(css.includes('[data-chat-flow-kind="tool-call"]'), false)
  assert.equal(css.includes('[data-code-block-banner]'), false)
  assert.equal(/\._[a-zA-Z0-9]{5,}_/.test(css), false, '不得依赖 CSS module hash 类名')
  assert.ok(css.includes('--dsw-alias-markdown-code-block'))
})

/* ------------------------------------------------------------------ */
/* 用户消息组件                                                        */
/* ------------------------------------------------------------------ */

test('用户消息组件输出 sanitize 后的 HTML，并带语义标记', () => {
  const { session } = createSession()
  const Component = session.createUserTextComponent()
  assert.equal(typeof Component, 'function')
  const rendered = Component({ node: { id: 'text', data: { text: '这是 **粗体**' } }, raw: '这是 **粗体**' })
  assert.equal(rendered.type, 'div')
  assert.equal(rendered.props['data-dsh-md'], 'user')
  assert.ok(rendered.props.dangerouslySetInnerHTML.__html.includes('<strong>粗体</strong>'))
})

test('预览检测沿祖先链找到 ellipsis 容器（槽锚点是 display:contents）', () => {
  const { session } = createSession()
  const anchor = { parentElement: null }
  const ellipsisWrapper = { parentElement: anchor }
  const host = { parentElement: ellipsisWrapper }
  // 默认窗口的 getComputedStyle 返回 textOverflow: 'clip'
  assert.equal(session.detectPreviewMode(host), false)
  const previewWindow = {
    document: createFakeDocument(),
    getComputedStyle(node) { return { textOverflow: node === ellipsisWrapper ? 'ellipsis' : 'clip' } },
    console,
  }
  const previewSession = createSession({ window: previewWindow }).session
  assert.equal(previewSession.detectPreviewMode(host), true)
})

test('用户消息优先采用上游 data.display（trim/collapse 规则的展示文本）', () => {
  const { session } = createSession()
  const Component = session.createUserTextComponent()
  const rendered = Component({
    node: { id: 'text', data: { text: '原始 **文本**', display: '折叠后 **展示**' } },
  })
  const html = rendered.props.dangerouslySetInnerHTML.__html
  assert.ok(html.includes('折叠后'), '未采用 data.display')
  assert.equal(html.includes('原始'), false, '错误地使用了 data.text')
  // display 为空串时回退 data.text（与「非空 string 优先」约定一致）
  const fallback = Component({ node: { id: 'text', data: { text: '**回退**', display: '' } } })
  assert.ok(fallback.props.dangerouslySetInnerHTML.__html.includes('<strong>回退</strong>'), '空 display 未回退 data.text')
})

test('空文本组件降级为纯文本 span，不产生空 div', () => {
  const { session } = createSession()
  const Component = session.createUserTextComponent()
  const rendered = Component({ node: { id: 'text', data: { text: '   ' } } })
  assert.equal(rendered.type, 'span')
  assert.equal(rendered.props['data-dsh-md'], 'user-text')
})

/* ------------------------------------------------------------------ */
/* 生成产物                                                            */
/* ------------------------------------------------------------------ */

test('client.js 是可加载的 classic script，内联了 marked/DOMPurify 且只 require react', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { stdio: 'pipe' })
  const bundle = readFileSync(join(ROOT, 'client.js'), 'utf8')
  assert.ok(bundle.startsWith('/**'))
  assert.ok(bundle.includes('window.__ModuleLoader__.load({'))
  assert.ok(bundle.includes('id: "dsh-markdown-session"'))
  assert.ok(bundle.includes('factory: function (require)'))
  assert.ok(bundle.includes('marked v16.4.2'))
  assert.ok(bundle.includes('DOMPurify 3.4.17'))
  assert.ok(bundle.includes('require("react")'))
  assert.ok(bundle.includes('GENERATED FILE'))
  assert.ok(bundle.length > 120000, `bundle 体积异常：${bundle.length}`)
})
