/**
 * dsh-markdown-session — shared runtime (browser bundle + node tests).
 *
 * 单包双半边里的「浏览器半边逻辑」。本文件被 scripts/build.mjs 拼进 client.js
 * 的模块闭包，同时被 test/*.test.mjs 直接 require 做纯逻辑单测。
 *
 * 设计要点（与 goal g-001 的调研结论一致）：
 *   1. 用户消息：shadow keyed 子槽 `conversation.user.text.node` key='text'
 *      （ui-conversation 注册 priority=100，我们用更低 priority 覆盖；keyed 槽同 key
 *      不同 priority 合法，最低 priority 渲染）。
 *      管线：marked(GFM) → DOMPurify 强白名单 → dangerouslySetInnerHTML。
 *   2. 助手消息：不接管 `conversation.chat.node`。DOM 后处理把「显示为字面文本的
 *      白名单 HTML」替换成清洗后的真实元素；只处理 settled（[data-text-interaction-source]）
 *      的 assistant-step 行，跳过 pre/code/思考块/代码块/KaTeX；替换记录可在卸载时还原。
 *   3. 所有消息内容一律视为不可信：白名单标签 + 白名单属性 + URI 策略 + afterSanitizeAttributes
 *      钩子（链接 rel、图片 src 限 http(s)/data:image）。没有 sanitizer 时一律不插入 HTML。
 *
 * UMD：node 下 module.exports = createMarkdownSession；浏览器 bundle 由 build 用
 * 局部 module 包一层后取出同一工厂。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.DshMarkdownSessionFactory = factory()
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMarkdownSessionModule() {
  'use strict'

  var PLUGIN_ID = 'dsh-markdown-session'
  var NS = PLUGIN_ID
  var ROOT_ATTR = 'data-dsh-md-session'
  var MARK_ATTR = 'data-dsh-md-html'
  var TEXT_NODE_SLOT = 'conversation.user.text.node'
  /** ui-conversation 用 100 注册 key='text'；更低 priority 覆盖（最低者渲染）。 */
  var SHADOW_PRIORITY = 90
  var DEBOUNCE_MS = 300
  var ASSISTANT_ROOT_SELECTOR = '[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]'
  var SKIP_SELECTOR = [
    'pre', 'code', 'textarea', 'script', 'style', 'noscript', 'svg', 'math',
    '[data-code-block-content]', '[data-variant="think"]',
    '[' + MARK_ATTR + ']', '[contenteditable="true"]',
    '.katex', '.katex-display',
  ].join(', ')
  var SKIP_TAGS = {
    PRE: 1, CODE: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1,
    SVG: 1, MATH: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, TEMPLATE: 1, CANVAS: 1,
  }

  /* ------------------------------------------------------------------ */
  /* 白名单与 URL 策略（纯函数）                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 允许出现在消息里的元素（GFM 渲染产物 + 受限内嵌 HTML）。
   * 不含 script/iframe/object/embed/form/input/button/select/textarea/svg/math。
   */
  var ALLOWED_TAGS = [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
    'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
    'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'u', 'ul', 'var', 'wbr',
  ]

  /** 允许的属性（全部为展示属性；不含 style、事件属性、id、name、class，避免 CSS 注入与 DOM clobbering）。 */
  var ALLOWED_ATTR = [
    'href', 'title', 'alt', 'src', 'open', 'align', 'colspan', 'rowspan', 'scope',
    'datetime', 'start', 'reversed', 'value', 'cite', 'dir', 'lang', 'width', 'height',
  ]

  /** 显式拒绝（与白名单互为双保险；DOMPurify 默认也会拦其中大部分）。 */
  var FORBID_TAGS = [
    'script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form',
    'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'svg', 'math',
    'template', 'noscript', 'frame', 'frameset', 'applet', 'audio', 'video', 'source',
    'track', 'canvas', 'map', 'area', 'portal', 'dialog', 'slot', 'animate', 'set',
  ]

  var FORBID_ATTR = [
    'style', 'srcset', 'srcdoc', 'formaction', 'xlink:href', 'xmlns', 'xmlns:xlink',
    'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'ontoggle', 'onbegin',
    'onend', 'onstart', 'onrepeat', 'background', 'poster', 'ping', 'target', 'id', 'name',
  ]

  /**
   * 只放行 http(s)、mailto、以及相对/锚点 URL（首字符非字母，或「字母开头但随后不是
   * scheme 冒号」）。javascript:/vbscript:/data:(非图片)/file:/blob: 一律不匹配。
   */
  var SAFE_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

  function normalizeUrl(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200d\ufeff]/g, '')
  }

  function schemeOf(value) {
    var match = /^([a-z][a-z0-9+.\-]*):/i.exec(normalizeUrl(value))
    return match === null ? '' : match[1].toLowerCase()
  }

  /** href 策略：https?/mailto/相对/锚点。 */
  function isSafeHref(value) {
    var normalized = normalizeUrl(value)
    if (normalized === '') return false
    var scheme = schemeOf(normalized)
    if (scheme === '') return true
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
  }

  /** img src 策略：https?/相对/data:image(位图 base64)；data:image/svg+xml 明确拒绝。 */
  function isSafeImageSrc(value) {
    var normalized = normalizeUrl(value)
    if (normalized === '') return false
    var scheme = schemeOf(normalized)
    if (scheme === '') return true
    if (scheme === 'http' || scheme === 'https') return true
    if (scheme === 'data') {
      return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(normalized)
    }
    return false
  }

  var ALLOWED_TAG_SET = Object.create(null)
  for (var tagIndex = 0; tagIndex < ALLOWED_TAGS.length; tagIndex++) {
    ALLOWED_TAG_SET[ALLOWED_TAGS[tagIndex]] = 1
  }

  var TAG_PROBE = /<\/?([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/gi

  /** 文本里是否出现白名单标签（决定是否值得解析；非白名单标签保持字面文本）。 */
  function hasWhitelistTag(text) {
    if (typeof text !== 'string' || text.indexOf('<') === -1) return false
    TAG_PROBE.lastIndex = 0
    var match
    while ((match = TAG_PROBE.exec(text)) !== null) {
      if (ALLOWED_TAG_SET[match[1].toLowerCase()] === 1) return true
    }
    return false
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function childElements(node) {
    var out = []
    if (node === null || node === undefined || !node.childNodes) return out
    for (var index = 0; index < node.childNodes.length; index++) {
      if (node.childNodes[index].nodeType === 1) out.push(node.childNodes[index])
    }
    return out
  }

  var DICTIONARIES = {
    zh: { 'table.region': 'Markdown 表格', 'bubble.assistant': '助手消息' },
    en: { 'table.region': 'Markdown table', 'bubble.assistant': 'Assistant message' },
  }

  /* ------------------------------------------------------------------ */
  /* 会话工厂（每实例一份 marked/DOMPurify/文档绑定）                      */
  /* ------------------------------------------------------------------ */

  /**
   * @param deps 依赖注入：{ React, marked, DOMPurify, document, window, MutationObserver,
   *   setTimeout, clearTimeout }
   * @returns 运行时 API（plugin/apply/renderUserMarkdown/createPatcher/... 与测试入口）
   */
  function createMarkdownSession(deps) {
    var options = deps || {}
    var win = options.window || (typeof window !== 'undefined' ? window : null)
    var doc = options.document || (win !== null && win !== undefined && win.document ? win.document : (typeof document !== 'undefined' ? document : null))
    var React = options.React || null
    var markedModule = options.marked || (win !== null && win !== undefined && win.marked ? win.marked : null)
    var purifier = options.DOMPurify || null
    var MutationObserverCtor = options.MutationObserver || (win !== null && win !== undefined && win.MutationObserver ? win.MutationObserver : null)
    var setTimer = options.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null)
    var clearTimer = options.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null)
    var hookInstalled = false
    var renderCache = new Map()

    var sanitizeConfig = Object.freeze({
      ALLOWED_TAGS: ALLOWED_TAGS.slice(),
      ALLOWED_ATTR: ALLOWED_ATTR.slice(),
      FORBID_TAGS: FORBID_TAGS.slice(),
      FORBID_ATTR: FORBID_ATTR.slice(),
      ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      KEEP_CONTENT: true,
      SANITIZE_DOM: true,
      RETURN_TRUSTED_TYPE: false,
    })

    function safeService(ctx, name) {
      if (ctx === null || ctx === undefined) return undefined
      try {
        var direct = ctx[name]
        if (direct) return direct
      } catch (error) { /* cordis 注入门禁：属性访问可能抛错 */ }
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch (error) {
        return undefined
      }
    }

    /* ---------------- sanitize ---------------- */

    function afterSanitizeAttributes(node) {
      if (node === null || node === undefined || node.nodeType !== 1) return
      var nodeTag = String(node.tagName || node.nodeName || '').toLowerCase()
      if (nodeTag === 'a') {
        var href = node.getAttribute('href')
        if (href !== null && href !== undefined && !isSafeHref(href)) node.removeAttribute('href')
        node.setAttribute('rel', 'noopener noreferrer')
      } else if (nodeTag === 'img') {
        var src = node.getAttribute('src')
        if (src !== null && src !== undefined && !isSafeImageSrc(src)) node.removeAttribute('src')
        if (node.getAttribute('src') === null) node.setAttribute('alt', node.getAttribute('alt') || 'image')
      }
    }

    function ensureHook() {
      if (hookInstalled || purifier === null || purifier === undefined || typeof purifier.addHook !== 'function') return
      purifier.addHook('afterSanitizeAttributes', afterSanitizeAttributes)
      hookInstalled = true
    }

    function removeHook() {
      if (!hookInstalled) return
      hookInstalled = false
      try {
        if (purifier !== null && purifier !== undefined && typeof purifier.removeHook === 'function') {
          purifier.removeHook('afterSanitizeAttributes')
        }
      } catch (error) { /* 卸载尽力而为 */ }
    }

    function sanitizeHtml(html) {
      if (purifier === null || purifier === undefined || typeof purifier.sanitize !== 'function') return ''
      ensureHook()
      var clean = purifier.sanitize(String(html == null ? '' : html), sanitizeConfig)
      return typeof clean === 'string' ? clean : ''
    }

    /* ---------------- 用户消息：marked → sanitize ---------------- */

    var MARKED_OPTIONS = { gfm: true, breaks: true, async: false }

    function renderUserMarkdown(text) {
      var source = String(text == null ? '' : text)
      if (source.trim() === '') return ''
      var cached = renderCache.get(source)
      if (cached !== undefined) return cached
      var html = ''
      if (markedModule !== null && markedModule !== undefined && typeof markedModule.parse === 'function') {
        try {
          var rendered = markedModule.parse(source, MARKED_OPTIONS)
          if (typeof rendered === 'string') html = sanitizeHtml(rendered)
        } catch (error) {
          html = ''
        }
      }
      if (html === '') {
        // 没有 marked / 没有 sanitizer / 解析失败：回退为转义纯文本，绝不直出原文。
        html = escapeHtml(source).replace(/\r?\n/g, '<br>')
      }
      if (renderCache.size >= 200) renderCache.clear()
      renderCache.set(source, html)
      return html
    }

    /* ---------------- 助手消息：字面 HTML 后处理 ---------------- */

    /** 收集 root 下「含有白名单标签字面文本」的文本节点，跳过受保护子树。 */
    function collectHtmlTextNodes(root) {
      var out = []
      if (root === null || root === undefined) return out
      var stack = [root]
      while (stack.length > 0) {
        var node = stack.pop()
        if (node === null || node === undefined) continue
        if (node.nodeType === 3) {
          if (hasWhitelistTag(node.nodeValue)) out.push(node)
          continue
        }
        if (node.nodeType !== 1) continue
        if (node.hasAttribute && node.hasAttribute(MARK_ATTR)) continue
        if (SKIP_TAGS[String(node.tagName || '').toUpperCase()] === 1) continue
        var matches = node.matches || node.msMatchesSelector
        if (typeof matches === 'function') {
          var skipped = false
          try { skipped = matches.call(node, SKIP_SELECTOR) } catch (error) { skipped = false }
          if (skipped) continue
        }
        var children = node.childNodes
        for (var index = children.length - 1; index >= 0; index--) stack.push(children[index])
      }
      return out
    }

    /**
     * 创建一个「字面 HTML → 真实元素」的后处理器。
     * scan(root) 就地替换；dispose() 逐条还原（卸载可逆）。
     * 没有 sanitizer 时拒绝工作（绝不插入未清洗 HTML）。
     */
    function createPatcher(patcherOptions) {
      var sanitize = (patcherOptions && patcherOptions.sanitize) || sanitizeHtml
      var records = []
      var stats = { scanned: 0, replaced: 0, restored: 0 }

      function available() {
        return doc !== null && doc !== undefined && typeof sanitize === 'function' && typeof doc.createElement === 'function'
      }

      function replaceTextNode(node) {
        var text = String(node.nodeValue == null ? '' : node.nodeValue)
        var parent = node.parentNode
        if (parent === null || parent === undefined) return false
        var probe = doc.createElement('template')
        probe.innerHTML = text
        var content = probe.content
        if (content === null || content === undefined) return false
        if (childElements(content).length === 0) return false
        var clean
        try {
          clean = sanitize(text)
        } catch (error) {
          return false
        }
        if (typeof clean !== 'string' || clean === '') return false
        var fragmentHost = doc.createElement('template')
        fragmentHost.innerHTML = clean
        var fragment = fragmentHost.content
        if (fragment === null || fragment === undefined || childElements(fragment).length === 0) return false
        var marker = doc.createComment('dsh-md-session:html')
        var inserted = []
        try {
          parent.insertBefore(marker, node)
          while (fragment.firstChild !== null) {
            var child = fragment.firstChild
            parent.insertBefore(child, node)
            inserted.push(child)
          }
          parent.removeChild(node)
        } catch (error) {
          // 回滚本次半成品，保持原文本节点。
          for (var rollback = 0; rollback < inserted.length; rollback++) {
            try { if (inserted[rollback].parentNode === parent) parent.removeChild(inserted[rollback]) } catch (ignored) { /* 已移除 */ }
          }
          try { if (marker.parentNode === parent) parent.removeChild(marker) } catch (ignored) { /* 已移除 */ }
          return false
        }
        for (var mark = 0; mark < inserted.length; mark++) {
          if (inserted[mark].nodeType === 1 && inserted[mark].setAttribute) inserted[mark].setAttribute(MARK_ATTR, '1')
        }
        records.push({ marker: marker, node: node, inserted: inserted })
        stats.replaced += 1
        return true
      }

      function scan(root) {
        if (!available()) return 0
        var nodes = collectHtmlTextNodes(root)
        stats.scanned += nodes.length
        var count = 0
        for (var index = 0; index < nodes.length; index++) {
          if (replaceTextNode(nodes[index])) count += 1
        }
        return count
      }

      function dispose() {
        for (var index = records.length - 1; index >= 0; index--) {
          var record = records[index]
          var parent = record.marker.parentNode
          if (parent === null || parent === undefined) continue
          for (var item = 0; item < record.inserted.length; item++) {
            try { if (record.inserted[item].parentNode === parent) parent.removeChild(record.inserted[item]) } catch (ignored) { /* 已移除 */ }
          }
          try {
            parent.insertBefore(record.node, record.marker)
            parent.removeChild(record.marker)
            stats.restored += 1
          } catch (ignored) { /* 位置已失效 */ }
        }
        records = []
      }

      return {
        scan: scan,
        dispose: dispose,
        get stats() { return { scanned: stats.scanned, replaced: stats.replaced, restored: stats.restored } },
        get recordCount() { return records.length },
        available: available,
      }
    }

    /* ---------------- 用户消息 React 组件 ---------------- */

    function detectPreviewMode(element) {
      if (element === null || element === undefined || win === null || win === undefined || typeof win.getComputedStyle !== 'function') return false
      try {
        // 槽锚点是 display:contents 的 span，真正的 ellipsis 容器在更上层；
        // text-overflow 不继承，所以要逐级向上找（最多 6 层，避免全树遍历）。
        var ancestor = element.parentElement
        for (var depth = 0; depth < 6 && ancestor !== null && ancestor !== undefined; depth++) {
          var style = win.getComputedStyle(ancestor)
          if (style !== null && style !== undefined && style.textOverflow === 'ellipsis') return true
          ancestor = ancestor.parentElement
        }
        return false
      } catch (error) {
        return false
      }
    }

    function decorateUserTables(element, labels) {
      if (element === null || element === undefined || typeof element.querySelectorAll !== 'function' || doc === null) return
      var tables = element.querySelectorAll('table')
      for (var index = 0; index < tables.length; index++) {
        var table = tables[index]
        var parent = table.parentElement
        if (parent === null || parent === undefined) continue
        if (parent.getAttribute && parent.getAttribute('data-dsh-md-table') === '1') continue
        var wrapper = doc.createElement('div')
        wrapper.setAttribute('data-dsh-md-table', '1')
        wrapper.setAttribute('class', 'dsh-md-table-scroll')
        wrapper.setAttribute('tabindex', '0')
        wrapper.setAttribute('role', 'region')
        wrapper.setAttribute('aria-label', labels.table)
        parent.insertBefore(wrapper, table)
        wrapper.appendChild(table)
      }
    }

    function createUserTextComponent() {
      if (React === null || React === undefined || typeof React.createElement !== 'function') return null
      function MarkdownUserText(props) {
        var node = props !== null && props !== undefined ? props.node : undefined
        var data = node !== null && node !== undefined ? node.data : undefined
        // 上游 PlainUserText 取 data.display ?? data.text；display 由 trim/collapse/
        // sessionReference 等规则产出（例如空白折叠为单个空格），必须优先采用。
        var text = data !== null && data !== undefined && typeof data.display === 'string' && data.display !== ''
          ? data.display
          : (data !== null && data !== undefined && typeof data.text === 'string'
            ? data.text
            : (props !== null && props !== undefined && typeof props.raw === 'string' ? props.raw : ''))
        var html = React.useMemo(function () { return renderUserMarkdown(text) }, [text])
        var containerRef = React.useRef(null)
        var previewState = React.useState(false)
        var preview = previewState[0]
        var setPreview = previewState[1]
        var lang = 'en'
        try {
          var documentLang = doc !== null && doc !== undefined && doc.documentElement ? String(doc.documentElement.lang || '') : ''
          if (documentLang.toLowerCase().indexOf('zh') === 0) lang = 'zh'
        } catch (error) { /* 默认英文标签 */ }
        var labels = { table: lang === 'zh' ? 'Markdown 表格' : 'Markdown table' }

        React.useEffect(function () {
          if (preview) return
          if (detectPreviewMode(containerRef.current)) setPreview(true)
        }, [preview])

        React.useEffect(function () {
          if (preview) return
          decorateUserTables(containerRef.current, labels)
        }, [html, preview])

        if (preview) {
          return React.createElement('span', {
            className: 'dsh-md-user-preview',
            'data-dsh-md': 'user-preview',
          }, text)
        }
        if (html === '') {
          return React.createElement('span', { 'data-dsh-md': 'user-text' }, text)
        }
        return React.createElement('div', {
          ref: containerRef,
          className: 'dsh-md-user',
          'data-dsh-md': 'user',
          dangerouslySetInnerHTML: { __html: html },
        })
      }
      MarkdownUserText.displayName = 'MarkdownSessionUserText'
      return MarkdownUserText
    }

    var UserTextComponent = createUserTextComponent()

    /* ---------------- 助手 DOM 后处理安装 ---------------- */

    function installAssistantProcessor() {
      if (doc === null || doc === undefined) return null
      var patcher = createPatcher({})
      var timer = null
      var stopped = false

      function run() {
        if (stopped) return
        if (typeof doc.querySelectorAll !== 'function') return
        var roots
        try {
          roots = doc.querySelectorAll(ASSISTANT_ROOT_SELECTOR)
        } catch (error) {
          return
        }
        for (var index = 0; index < roots.length; index++) {
          try { patcher.scan(roots[index]) } catch (error) { /* 单条消息失败不影响其它消息 */ }
        }
      }

      function schedule() {
        if (stopped || setTimer === null) return
        if (timer !== null) return
        timer = setTimer(function () {
          timer = null
          try { run() } catch (error) { /* 异步回调不抛出 */ }
        }, DEBOUNCE_MS)
      }

      var observer = null
      if (MutationObserverCtor !== null && typeof MutationObserverCtor === 'function') {
        try {
          observer = new MutationObserverCtor(schedule)
          observer.observe(doc.body || doc.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
          })
        } catch (error) {
          observer = null
        }
      }
      run()

      return {
        scanNow: run,
        dispose: function () {
          stopped = true
          if (timer !== null && clearTimer !== null) clearTimer(timer)
          timer = null
          try { if (observer !== null) observer.disconnect() } catch (error) { /* 已断开 */ }
          patcher.dispose()
          removeHook()
        },
        patcher: patcher,
      }
    }

    /* ---------------- 插件生命周期 ---------------- */

    function apply(ctx) {
      var disposers = []
      var disposed = false

      function addDisposer(disposer) {
        if (typeof disposer === 'function') disposers.push(disposer)
      }

      function dispose() {
        if (disposed) return
        disposed = true
        while (disposers.length > 0) {
          var disposer = disposers.pop()
          try { disposer() } catch (error) { /* 卸载逐项尽力而为 */ }
        }
      }

      if (ctx === null || ctx === undefined || !ctx.slots) return dispose

      if (doc !== null && doc !== undefined && doc.documentElement) {
        try { doc.documentElement.setAttribute(ROOT_ATTR, 'on') } catch (error) { /* 无 DOM 时忽略 */ }
        addDisposer(function () {
          try { doc.documentElement.removeAttribute(ROOT_ATTR) } catch (error) { /* 已移除 */ }
        })
      }

      if (doc !== null && doc !== undefined && doc.head) {
        var styleElement = doc.createElement('style')
        styleElement.setAttribute('data-plugin', PLUGIN_ID)
        styleElement.textContent = CSS
        try { doc.head.appendChild(styleElement) } catch (error) { styleElement = null }
        if (styleElement !== null) {
          addDisposer(function () {
            try { if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement) } catch (error) { /* 已移除 */ }
          })
        }
      }

      var locale = safeService(ctx, 'locale')
      if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
        try {
          var localeDisposer = locale.register(NS, DICTIONARIES)
          addDisposer(localeDisposer)
        } catch (error) { /* 字典注册失败不影响渲染 */ }
      }

      if (UserTextComponent !== null && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
        try {
          var slotDisposer = ctx.slots.inject(TEXT_NODE_SLOT, function () {
            return ctx.slots.register({
              name: TEXT_NODE_SLOT,
              key: 'text',
              priority: SHADOW_PRIORITY,
            }, UserTextComponent)
          })
          addDisposer(slotDisposer)
        } catch (error) {
          // 槽未声明或被别的插件占用：静默降级为原生纯文本，不拖垮整页。
          if (win !== null && win !== undefined && win.console && typeof win.console.warn === 'function') {
            win.console.warn('[dsh-markdown-session] 用户消息渲染器注册失败，已降级为纯文本：', error)
          }
        }
      }

      var processor = installAssistantProcessor()
      if (processor !== null) addDisposer(processor.dispose)

      if (typeof ctx.effect === 'function') {
        try {
          ctx.effect(function () { return dispose }, 'dsh-markdown-session: lifecycle')
        } catch (error) { /* 旧宿主没有 effect：手动 dispose 仍可用 */ }
      }

      return dispose
    }

    var plugin = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply: apply,
    }

    var api = {
      plugin: plugin,
      apply: apply,
      NS: NS,
      ROOT_ATTR: ROOT_ATTR,
      MARK_ATTR: MARK_ATTR,
      SHADOW_PRIORITY: SHADOW_PRIORITY,
      TEXT_NODE_SLOT: TEXT_NODE_SLOT,
      ASSISTANT_ROOT_SELECTOR: ASSISTANT_ROOT_SELECTOR,
      SKIP_SELECTOR: SKIP_SELECTOR,
      CSS: CSS,
      DICTIONARIES: DICTIONARIES,
      renderUserMarkdown: renderUserMarkdown,
      sanitizeHtml: sanitizeHtml,
      createPatcher: createPatcher,
      collectHtmlTextNodes: collectHtmlTextNodes,
      hasWhitelistTag: hasWhitelistTag,
      isSafeHref: isSafeHref,
      isSafeImageSrc: isSafeImageSrc,
      normalizeUrl: normalizeUrl,
      escapeHtml: escapeHtml,
      createUserTextComponent: function () { return UserTextComponent },
      decorateUserTables: decorateUserTables,
      detectPreviewMode: detectPreviewMode,
      clearCache: function () { renderCache.clear() },
      __internals: {
        ALLOWED_TAGS: ALLOWED_TAGS,
        ALLOWED_ATTR: ALLOWED_ATTR,
        FORBID_TAGS: FORBID_TAGS,
        FORBID_ATTR: FORBID_ATTR,
        SANITIZE_CONFIG: sanitizeConfig,
        SAFE_URI_REGEXP: SAFE_URI_REGEXP,
      },
    }

    // 仅测试入口；宿主不消费（同 dsh-graph 的 __test 约定）。
    plugin.__test = api
    return api
  }

  /* ------------------------------------------------------------------ */
  /* 样式（随 apply 注入，卸载时移除；全部以 html[data-dsh-md-session] 作用域） */
  /* ------------------------------------------------------------------ */

  var CSS = [
    /* ---- 用户气泡：markdown 容器覆盖气泡的 pre-wrap ---- */
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble]{white-space:normal}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"]{white-space:normal;overflow-wrap:anywhere;min-width:0;max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary)}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :first-child{margin-top:0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :last-child{margin-bottom:0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] p{margin:6px 0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :is(h1,h2,h3,h4,h5,h6){margin:12px 0 6px;line-height:1.35;font-weight:600}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] h1{font-size:1.3em}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] h2{font-size:1.18em}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] h3{font-size:1.08em}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :is(h4,h5,h6){font-size:1em}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :is(ul,ol){margin:6px 0;padding-left:20px}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] li{margin:2px 0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] li>p{margin:2px 0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] a{color:var(--dsw-alias-link);text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:12px 0}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] img{max-width:100%;height:auto;border-radius:var(--dsw-radius-sm,4px)}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] :not(pre)>code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);background:var(--dsw-alias-markdown-inline-code);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,4px);padding:0 5px;font-size:.875em}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] pre{margin:8px 0;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-markdown-code-block);overflow-x:auto;max-width:100%}',
    'html[' + ROOT_ATTR + '="on"] [data-message-bubble] [data-dsh-md="user"] pre code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.875em;background:none;border:none;padding:0;white-space:pre}',
    '.dsh-md-user-preview{display:inline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '.dsh-md-table-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;margin:8px 0}',
    '.dsh-md-table-scroll:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
    /* ---- 表格：边框 + 斑马纹（用户侧、内嵌 HTML） ---- */
    'html[' + ROOT_ATTR + '="on"] :is([data-dsh-md="user"],[' + MARK_ATTR + ']) table{border-collapse:collapse;width:max-content;min-width:100%;margin:0}',
    'html[' + ROOT_ATTR + '="on"] :is([data-dsh-md="user"],[' + MARK_ATTR + ']) :is(th,td){border:1px solid var(--dsw-alias-border-l2);padding:6px 10px;text-align:left;vertical-align:top;font:inherit}',
    'html[' + ROOT_ATTR + '="on"] :is([data-dsh-md="user"],[' + MARK_ATTR + ']) th{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}',
    'html[' + ROOT_ATTR + '="on"] :is([data-dsh-md="user"],[' + MARK_ATTR + ']) tbody tr:nth-child(even){background:var(--dsw-alias-interactive-bg-hover)}',
    'html[' + ROOT_ATTR + '="on"] :is([data-dsh-md="user"],[' + MARK_ATTR + ']) caption{caption-side:bottom;padding-top:4px;color:var(--dsw-alias-label-tertiary);font-size:.9em}',
    /* ---- 助手原生 Markdown 表格：气泡内也做边框 + 斑马纹（判据 9） ---- */
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] [data-text-interaction-source] table{border-collapse:collapse}',
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] [data-text-interaction-source] :is(th,td){border:1px solid var(--dsw-alias-border-l2);padding:8px 12px}',
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] [data-text-interaction-source] th{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}',
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] [data-text-interaction-source] tbody tr:nth-child(even){background:var(--dsw-alias-interactive-bg-hover)}',
    /* ---- 白名单内嵌 HTML 的外观 ---- */
    'html[' + ROOT_ATTR + '="on"] [' + MARK_ATTR + ']:is(div,details,table,ul,ol,dl,blockquote,pre,hr,figure){margin:8px 0}',
    'html[' + ROOT_ATTR + '="on"] [' + MARK_ATTR + '] :is(details,summary){margin:0}',
    'html[' + ROOT_ATTR + '="on"] details[' + MARK_ATTR + ']{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);padding:6px 10px;background:var(--dsw-alias-bg-base)}',
    'html[' + ROOT_ATTR + '="on"] details[' + MARK_ATTR + '] summary{cursor:pointer;font-weight:600;padding:2px 0}',
    'html[' + ROOT_ATTR + '="on"] kbd[' + MARK_ATTR + ']{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);border:.5px solid var(--dsw-alias-border-l2);border-bottom-width:2px;border-radius:var(--dsw-radius-sm,4px);padding:0 4px;font-size:.875em;background:var(--dsw-alias-markdown-inline-code)}',
    'html[' + ROOT_ATTR + '="on"] mark[' + MARK_ATTR + ']{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,transparent);color:inherit;border-radius:2px;padding:0 2px}',
    'html[' + ROOT_ATTR + '="on"] [' + MARK_ATTR + '] a{color:var(--dsw-alias-link)}',
    'html[' + ROOT_ATTR + '="on"] [' + MARK_ATTR + '] img{max-width:100%;height:auto}',
    /* ---- 助手气泡：消息级外壳，锚在 AssistantMarkdown 根 div。
       ChatNodeSeat 行 div（[data-chat-flow-kind]）→ slot 锚 [data-slot="conversation.chat.node"]
       （display:contents）→ AssistantNodeView/AssistantMarkdown 唯一根 div。
       该根 div 在流式（data-streaming）与历史中间 step 上同样存在，因此气泡不再依赖
       「settled 才置位」的 [data-text-interaction-source]；后处理仍只看 settled。 ---- */
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] > [data-slot="conversation.chat.node"] > div{box-sizing:border-box;align-self:flex-start;width:fit-content;max-width:min(calc(var(--dsh-chat-content-width,748px) * 0.86),100%);padding:12px 16px;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
    /* 宽表破栏依赖 100cqw 与内容列宽；气泡内改为气泡内滚动（判据 9），流式/落定都生效。 */
    'html[' + ROOT_ATTR + '="on"] [data-chat-flow-kind="assistant-step"] > [data-slot="conversation.chat.node"] > div .md-table-wide{width:100%!important;max-width:100%!important;overflow-x:auto!important;margin-left:0!important;padding-left:0!important}',
  ].join('\n')

  return createMarkdownSession
}))
