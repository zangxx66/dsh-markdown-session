/**
 * dsh-markdown-session — 真浏览器 E2E（无头 Chrome 加载本页后 dump DOM 取结果）。
 *
 * 这层验证 node 单测覆盖不到的部分：
 *   - 真实 DOMPurify 对 30+ XSS payload 的清洗结果（并实际插入 DOM，确认零执行）
 *   - 真 DOM 的「字面 HTML → 真实元素」替换与卸载还原
 *   - apply 后样式注入、MutationObserver 去抖、dispose 摘监听
 *   - 浅/深色气泡对比度（WCAG 4.5:1）与宽表「气泡内滚动、页面不横向撑破」
 *   - 工具卡/思考块/按钮等既有 UI 的负向回归
 */
(function () {
  'use strict'

  var results = []
  var stage = document.getElementById('stage')
  var output = document.getElementById('e2e-results')

  function record(name, error) {
    if (error === undefined) results.push({ name: name, ok: true })
    else results.push({ name: name, ok: false, error: String((error && error.message) || error) })
  }

  async function check(name, fn) {
    try {
      await fn()
      record(name)
    } catch (error) {
      record(name, error)
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed')
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error((message || 'not equal') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag)
    if (attrs) for (var key in attrs) node.setAttribute(key, attrs[key])
    if (text !== undefined) node.textContent = text
    return node
  }

  function colorOf(value) {
    var match = String(value || '').match(/rgba?\(([^)]+)\)/)
    if (match === null) return null
    var parts = match[1].split(',').map(function (part) { return parseFloat(part.trim()) })
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }

  function luminance(color) {
    function channel(value) {
      var scaled = value / 255
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  }

  function contrastRatio(textColor, backgroundColor) {
    var a = luminance(textColor)
    var b = luminance(backgroundColor)
    var high = Math.max(a, b) + 0.05
    var low = Math.min(a, b) + 0.05
    return high / low
  }

  function textContrast(element, backgroundElement) {
    var style = window.getComputedStyle(element)
    var backgroundStyle = window.getComputedStyle(backgroundElement || element)
    var text = colorOf(style.color)
    var background = colorOf(backgroundStyle.backgroundColor)
    assert(text !== null, 'text color unparsable: ' + style.color)
    assert(background !== null, 'background unparsable: ' + backgroundStyle.backgroundColor)
    return { ratio: contrastRatio(text, background), text: style.color, background: backgroundStyle.backgroundColor }
  }

  var fakeReact = {
    createElement: function (type, props) {
      return { type: type, props: props || {} }
    },
    useMemo: function (factory) { return factory() },
    useRef: function (value) { return { current: value } },
    useState: function (value) { return [value, function () {}] },
    useEffect: function () {},
  }

  function materializePlugin() {
    var registration = window.__registration
    assert(registration && typeof registration.factory === 'function', 'client.js 未调用 __ModuleLoader__.load')
    assertEqual(registration.id, 'dsh-markdown-session', '注册 id')
    var plugin = registration.factory(function (specifier) {
      if (specifier === 'react') return fakeReact
      throw new Error('未声明的 require: ' + specifier)
    })
    assert(plugin && typeof plugin.apply === 'function', 'factory 未返回插件对象')
    assertEqual(plugin.name, 'dsh-markdown-session', '插件名')
    assert(Array.isArray(plugin.inject) && plugin.inject.indexOf('slots') >= 0, '插件未声明 slots 注入')
    assert(plugin.__test && typeof plugin.__test.renderUserMarkdown === 'function', '缺少 __test 入口')
    return plugin
  }

  function createFakeCtx() {
    var context = {
      slot: null,
      disposers: [],
      slots: {
        inject: function (name, callback) {
          assertEqual(name, 'conversation.user.text.node', 'slots.inject 槽名')
          var disposer = callback()
          context.disposers.push(disposer)
          return disposer
        },
        register: function (options, component) {
          context.slot = { options: options, component: component }
          return function () { context.slot = null }
        },
      },
      effect: function (callback) {
        var disposer = callback()
        if (typeof disposer === 'function') context.disposers.push(disposer)
        return disposer
      },
      get: function () { return undefined },
    }
    return context
  }

  /* ------------------------------------------------------------------ */

  function xssPayloads() {
    return [
      ['script-tag', '<script>window.__xss += 1</script><b>ok</b>'],
      ['img-onerror', '<img src=x onerror="window.__xss += 1">'],
      ['img-onerror-unquoted', '<img src=x onerror=window.__xss+=1>'],
      ['svg-onload', '<svg onload="window.__xss += 1"></svg>'],
      ['javascript-href', '<a href="javascript:window.__xss += 1">x</a>'],
      ['javascript-href-entity', '<a href="java&#115;cript:window.__xss += 1">x</a>'],
      ['javascript-href-whitespace', '<a href="java\nscript:window.__xss += 1">x</a>'],
      ['data-href', '<a href="data:text/html,<script>window.__xss += 1</script>">x</a>'],
      ['iframe-srcdoc', '<iframe srcdoc="<script>window.__xss += 1</script>"></iframe>'],
      ['iframe-src', '<iframe src="javascript:window.__xss += 1"></iframe>'],
      ['object-data', '<object data="javascript:window.__xss += 1"></object>'],
      ['embed-src', '<embed src="javascript:window.__xss += 1">'],
      ['form-action', '<form action="javascript:window.__xss += 1"><input type="submit"></form>'],
      ['button-formaction', '<button formaction="javascript:window.__xss += 1">x</button>'],
      ['details-ontoggle', '<details open ontoggle="window.__xss += 1"><summary>s</summary>d</details>'],
      ['style-tag', '<style>@import "javascript:window.__xss += 1";</style><b>ok</b>'],
      ['math-script', '<math><mtext><script>window.__xss += 1</script></mtext></math>'],
      ['svg-xlink', '<svg><a xlink:href="javascript:window.__xss += 1">x</a></svg>'],
      ['img-data-html', '<img src="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX3hzcz0xPC9zY3JpcHQ+">'],
      ['img-data-svg', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
      ['body-onload', '<body onload="window.__xss += 1">x</body>'],
      ['meta-refresh', '<meta http-equiv="refresh" content="0;url=javascript:window.__xss += 1">'],
      ['base-tag', '<base href="javascript:window.__xss += 1">'],
      ['template-script', '<template><script>window.__xss += 1</script></template>'],
      ['video-src', '<video src="javascript:window.__xss += 1"></video>'],
      ['input-onfocus', '<input autofocus onfocus="window.__xss += 1">'],
      ['link-import', '<link rel="import" href="javascript:window.__xss += 1">'],
      ['style-attr', '<div style="background:url(javascript:window.__xss += 1)">x</div>'],
      ['b-onclick', '<b onclick="window.__xss += 1">x</b>'],
      ['mixed-forbidden', '<b>ok</b><script>window.__xss += 1</script><iframe src="javascript:window.__xss += 1"></iframe>'],
      ['write-through-img', '<img src="x" onerror="document.body.setAttribute(\'data-pwned\',\'1\')">'],
      ['anchor-target', '<a href="https://example.com" target="_top">x</a>'],
    ]
  }

  var FORBIDDEN_ELEMENTS = 'script,iframe,object,embed,form,input,button,select,option,textarea,svg,math,style,link,meta,base,template,video,audio,source,canvas,frame,frameset,applet'
  var FORBIDDEN_PATTERN = /(<script|\son[a-z]+\s*=|javascript:|vbscript:|<iframe|<object|<embed|<form|<input|<button|<select|<textarea|<svg|<math|<style|<link|<base|<template|srcdoc|formaction|srcset|xlink:href)/i

  async function run() {
    var plugin = materializePlugin()
    var api = plugin.__test

    /* ---- 1. XSS 负向：真实 DOMPurify + 真 DOM 插入 ---- */
    var payloads = xssPayloads()
    for (var index = 0; index < payloads.length; index++) {
      var payload = payloads[index]
      var name = payload[0]
      var dirty = payload[1]
      await check('xss/' + name, function () {
        var clean = api.sanitizeHtml(dirty)
        assertEqual(typeof clean, 'string', 'sanitize 返回值类型')
        assert(!FORBIDDEN_PATTERN.test(clean), '清洗结果仍含危险面: ' + clean)
        var host = document.createElement('div')
        host.innerHTML = clean
        document.body.appendChild(host)
        assertEqual(host.querySelectorAll(FORBIDDEN_ELEMENTS).length, 0, 'DOM 中出现被禁元素')
        assert(!host.querySelector('*[srcdoc],*[formaction],*[srcset],*[xlink\\:href]'), 'DOM 中出现被禁属性')
        var badEvents = 0
        var all = host.querySelectorAll('*')
        for (var nodeIndex = 0; nodeIndex < all.length; nodeIndex++) {
          var attrs = all[nodeIndex].attributes
          for (var attrIndex = 0; attrIndex < attrs.length; attrIndex++) {
            if (/^on/i.test(attrs[attrIndex].name)) badEvents += 1
          }
        }
        assertEqual(badEvents, 0, '残留事件属性')
        host.remove()
      })
      await wait(20)
    }
    assertEqual(window.__xss, 0, 'XSS payload 执行了（window.__xss != 0）')
    assertEqual(document.body.getAttribute('data-pwned'), null, 'payload 改写了 body')
    await check('xss/链接补 rel', function () {
      var clean = api.sanitizeHtml('<a href="https://example.com/x">链接</a>')
      var host = document.createElement('div')
      host.innerHTML = clean
      var link = host.querySelector('a')
      assert(link !== null, '安全链接被误删')
      assertEqual(link.getAttribute('rel'), 'noopener noreferrer', '缺少 rel')
      host.remove()
    })
    await check('xss/安全内容保留', function () {
      var clean = api.sanitizeHtml('<details open><summary>摘要</summary><b>粗</b><kbd>Ctrl</kbd></details><table><tr><td>1</td></tr></table><img src="https://example.com/a.png" alt="a">')
      var host = document.createElement('div')
      host.innerHTML = clean
      assert(host.querySelector('details') !== null, 'details 被误删')
      assert(host.querySelector('kbd') !== null, 'kbd 被误删')
      assert(host.querySelector('table td') !== null, 'table 被误删')
      assert(host.querySelector('img[src^="https://"]') !== null, 'https 图片被误删')
      host.remove()
    })

    /* ---- 2. 用户消息 GFM 渲染 ---- */
    await check('user-markdown/GFM 全要素', function () {
      var source = [
        '# 标题',
        '',
        '**粗** *斜* ~~删~~ 与 `code`',
        '',
        '- 甲',
        '- 乙',
        '',
        '1. 一',
        '2. 二',
        '',
        '> 引用',
        '',
        '```js',
        'const x = 1',
        '```',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '[链接](https://example.com)',
        '',
        '---',
      ].join('\n')
      var html = api.renderUserMarkdown(source)
      var host = document.createElement('div')
      host.innerHTML = html
      for (var selector of ['h1', 'strong', 'em', 'del', 'ul li', 'ol li', 'blockquote', 'code', 'pre code', 'table th', 'table td', 'a[href="https://example.com"]', 'hr']) {
        assert(host.querySelector(selector) !== null, '缺少 ' + selector)
      }
      assert(host.querySelector('script') === null, '渲染结果出现 script')
      host.remove()
    })

    await check('user-markdown/XSS 经完整渲染管线不执行', async function () {
      var host = document.createElement('div')
      host.innerHTML = api.renderUserMarkdown('文本 <img src=x onerror="window.__xss += 1"> <script>window.__xss += 1<\/script> <b>ok</b>')
      document.body.appendChild(host)
      await wait(80)
      assertEqual(window.__xss, 0, '用户渲染管线 XSS 执行了')
      assertEqual(host.querySelectorAll('img[onerror],script').length, 0, '危险元素/属性残留')
      assert(host.querySelector('b') !== null, '白名单标签未渲染')
      host.remove()
    })

    await check('user-markdown/data:image 与 mailto 按策略放行', function () {
      var host = document.createElement('div')
      host.innerHTML = api.renderUserMarkdown('![图](data:image/png;base64,iVBORw0KGgo=) [邮件](mailto:a@example.com)')
      assert(host.querySelector('img[src^="data:image/png"]') !== null, 'data:image 被误删')
      assert(host.querySelector('a[href^="mailto:"]') !== null, 'mailto 被误删')
      host.remove()
    })

    /* ---- 3. 助手字面 HTML 后处理（detached，避免观察器干扰） ---- */
    await check('assistant/字面 HTML 替换为真实元素', function () {
      var root = el('div', { 'data-chat-flow-kind': 'assistant-step' })
      var body = el('div', { 'data-text-interaction-source': '' })
      var paragraph = el('p', null, '开头 <b>粗体</b> 与 <details open><summary>摘要</summary>细节</details> 结尾')
      var code = el('pre', { 'data-code-block-content': '' })
      var codeInner = el('code', null, '<b>代码里不改</b>')
      code.appendChild(codeInner)
      var think = el('div', { 'data-variant': 'think' })
      think.textContent = '<b>思考里不改</b>'
      body.append(paragraph, code, think)
      root.appendChild(body)
      var patcher = api.createPatcher({})
      assertEqual(patcher.scan(root), 1, '应只替换 1 个段落文本节点')
      assert(paragraph.querySelector('b') !== null, '段落未生成 b')
      assert(paragraph.querySelector('details') !== null, '段落未生成 details')
      assertEqual(codeInner.textContent, '<b>代码里不改</b>', '代码块被改动')
      assertEqual(codeInner.querySelector('b'), null, '代码块内被生成元素')
      assertEqual(think.textContent, '<b>思考里不改</b>', '思考块被改动')
      var original = '开头 <b>粗体</b> 与 <details open><summary>摘要</summary>细节</details> 结尾'
      patcher.dispose()
      assertEqual(paragraph.textContent, original, '卸载未还原字面文本')
      assertEqual(paragraph.querySelector('b'), null, '卸载后仍有注入元素')
    })

    await check('assistant/XSS 不执行且卸载还原', async function () {
      var root = el('div', { 'data-chat-flow-kind': 'assistant-step' })
      var body = el('div', { 'data-text-interaction-source': '' })
      var paragraph = el('p', null, 'x <img src=x onerror="window.__xss += 1"><a href="javascript:window.__xss += 1">链接</a> <b>ok</b>')
      body.appendChild(paragraph)
      root.appendChild(body)
      document.body.appendChild(root)
      var patcher = api.createPatcher({})
      patcher.scan(root)
      await wait(80)
      assertEqual(window.__xss, 0, '助手路径 XSS 执行了')
      assertEqual(paragraph.querySelectorAll('img[onerror]').length, 0, 'onerror 未清除')
      assertEqual(paragraph.querySelectorAll('a[href^="javascript"]').length, 0, 'javascript: href 未清除')
      assert(paragraph.querySelector('b') !== null, '安全标签未渲染')
      patcher.dispose()
      root.remove()
    })

    await check('assistant/跨文本节点混合 HTML：details+summary+kbd+md 加粗', async function () {
      // 复刻真机：上游把一段 raw HTML 拆成多个相邻 DOM 文本节点，
      // 中间还隔着 md 渲染出的 <strong>；逐节点处理会产出空壳 details + 游离闭合标签。
      var host = el('div')
      var paragraph = el('p')
      var strong = el('strong', null, '加粗')
      var pieces = [
        '…测试组：', '<details>', '<summary>', '标题文本', '</summary>',
        '正文有 ', '<kbd>', 'Ctrl', '</kbd>+', '<kbd>', 'V', '</kbd> 与 ',
      ]
      for (var index = 0; index < pieces.length; index++) paragraph.appendChild(document.createTextNode(pieces[index]))
      paragraph.appendChild(strong)
      paragraph.appendChild(document.createTextNode('。'))
      paragraph.appendChild(document.createTextNode('</details>'))
      host.appendChild(paragraph)
      document.body.appendChild(host)
      var originalText = paragraph.textContent

      var patcher = api.createPatcher({})
      var replaced = patcher.scan(paragraph)
      assertEqual(replaced, 1, '相邻文本段应合并为 1 次替换')
      var details = paragraph.querySelector('details')
      assert(details !== null, '未生成 details')
      assertEqual(details.querySelector('summary').textContent, '标题文本', 'summary 文本不完整')
      assert(details.contains(strong), 'md 加粗节点未保留在 details 内')
      var innerText = paragraph.textContent
      assertEqual(innerText.indexOf('</summary>'), -1, '残留 </summary> 文本')
      assertEqual(innerText.indexOf('</details>'), -1, '残留 </details> 文本')
      assertEqual(innerText.indexOf('</kbd>'), -1, '残留 </kbd> 文本')
      assertEqual(details.open, false, 'details 默认不应展开')
      details.querySelector('summary').click()
      assertEqual(details.open, true, 'details 无法展开')
      await wait(30)
      assert(details.textContent.indexOf('正文有') >= 0, '展开后正文丢失')
      assert(details.textContent.indexOf('加粗') >= 0, '展开后加粗文本丢失')

      patcher.dispose()
      assertEqual(paragraph.textContent, originalText, 'dispose 未逐字还原')
      assertEqual(paragraph.querySelector('details'), null, 'dispose 后 details 残留')
      assertEqual(strong.parentNode, paragraph, 'dispose 后 md 加粗节点未归位')
      host.remove()
    })

    await check('assistant/跨文本节点拼接不得引入注入面', async function () {
      var host = el('div')
      var paragraph = el('p')
      var pieces = [
        '<details open ontoggle="window.__xss += 1">', '<summary>', '摘要', '</summary>',
        '<img src=x onerror="window.__xss += 1">', '</details>',
      ]
      for (var index = 0; index < pieces.length; index++) paragraph.appendChild(document.createTextNode(pieces[index]))
      host.appendChild(paragraph)
      document.body.appendChild(host)
      var patcher = api.createPatcher({})
      patcher.scan(paragraph)
      await wait(80)
      assertEqual(window.__xss, 0, '跨节点拼接引入 XSS')
      assert(paragraph.querySelector('details') !== null, 'details 未生成')
      assertEqual(paragraph.querySelectorAll('img[onerror]').length, 0, 'onerror 残留')
      assertEqual(paragraph.querySelectorAll('[ontoggle]').length, 0, 'ontoggle 残留')
      patcher.dispose()
      host.remove()
    })

    await check('assistant/HTML 跨到受保护元素时整段放弃（保持字面，不产出半截结构）', function () {
      var host = el('div')
      var paragraph = el('p')
      paragraph.appendChild(document.createTextNode('<details><summary>标题</summary>'))
      var code = el('pre')
      code.textContent = '<b>代码块</b>'
      paragraph.appendChild(code)
      paragraph.appendChild(document.createTextNode('</details>'))
      host.appendChild(paragraph)
      document.body.appendChild(host)
      var original = paragraph.textContent
      var patcher = api.createPatcher({})
      assertEqual(patcher.scan(paragraph), 0, '受保护元素应阻断拼接')
      assertEqual(paragraph.querySelector('details'), null, '不应产出半截 details')
      assertEqual(paragraph.textContent, original, '放弃时必须保持字面原文')
      patcher.dispose()
      host.remove()
    })

    await check('assistant/无 sanitizer 时失败关闭（不插入任何 HTML）', function () {
      var host = el('div')
      var paragraph = el('p')
      paragraph.textContent = '危险 <b>不应渲染</b>'
      host.appendChild(paragraph)
      document.body.appendChild(host)
      var patcher = api.createPatcher({ sanitize: function () { return '' } })
      assertEqual(patcher.scan(paragraph), 0, '无 sanitizer 仍尝试替换')
      assertEqual(paragraph.querySelector('b'), null, '无 sanitizer 时插入了 HTML')
      assertEqual(paragraph.textContent, '危险 <b>不应渲染</b>', '原文被改动')
      patcher.dispose()
      host.remove()
    })

    /* ---- 4. 表格装饰（组件 effect 的纯函数入口） ---- */
    await check('user-markdown/表格包装为可滚动 region', function () {
      var container = el('div', { 'data-dsh-md': 'user' })
      container.innerHTML = api.renderUserMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
      api.decorateUserTables(container, { table: 'Markdown 表格' })
      var wrapper = container.querySelector('.dsh-md-table-scroll')
      assert(wrapper !== null, '未生成滚动包装')
      assertEqual(wrapper.getAttribute('role'), 'region', '缺少 role=region')
      assertEqual(wrapper.getAttribute('tabindex'), '0', '缺少 tabindex')
      assert(wrapper.querySelector('table') !== null, '表格不在包装内')
    })

    /* ---- 5. apply：气泡（流式+落定）、样式、槽注册、观察器、对比度、回归、卸载 ---- */
    stage.innerHTML = ''

    /**
     * 复刻 ui-chat 的真实消息结构：
     *   div[data-chat-flow-kind="assistant-step"]
     *     > div[data-slot="conversation.chat.node"]（display:contents）
     *       > AssistantMarkdown 根 div
     *         > .body
     *           > MarkdownText 根 div（settled 才有 data-text-interaction-source）
     *           > 思考块 / 隐藏过程
     */
    function buildAssistantRow(options) {
      var opts = options || {}
      var flow = el('div', { 'data-chat-flow-kind': 'assistant-step' })
      if (opts.groupPart) flow.setAttribute('data-chat-group-part', opts.groupPart)
      var anchor = el('div', { 'data-slot': 'conversation.chat.node' })
      var root = el('div', { class: 'assist-root' })
      if (opts.streaming) root.setAttribute('data-streaming', '')
      var body = el('div', { class: 'assist-body' })
      var markdown = el('div', { class: 'markdown' })
      var render = { flow: flow, anchor: anchor, root: root, body: body, markdown: markdown }
      if (opts.reasoningOnly) {
        // 真实结构：body > 思考 wrapper（隐藏时带 data-turn-process-inline + hidden）> ReasoningRow[data-variant="think"]
        var wrapper = el('div', {})
        if (opts.hidden) {
          wrapper.setAttribute('data-turn-process-inline', '')
          wrapper.setAttribute('hidden', '')
        }
        var inner = el('div', { 'data-variant': 'think', class: 'fake-think' })
        inner.textContent = '思考中…（无可见正文）'
        wrapper.appendChild(inner)
        body.appendChild(wrapper)
        render.reasoningWrapper = wrapper
        render.think = inner
        root.appendChild(body)
        anchor.appendChild(root)
        flow.appendChild(anchor)
        return render
      }
      if (opts.empty) {
        // 只有 tool-call 的 streaming step：tool-call 被分组到独立行，正文为空
        root.appendChild(body)
        anchor.appendChild(root)
        flow.appendChild(anchor)
        return render
      }
      if (opts.textInteractionSource) markdown.setAttribute('data-text-interaction-source', '')
      if (opts.markdown) markdown.innerHTML = api.renderUserMarkdown(opts.markdown)
      if (opts.literalHtml) {
        var paragraph = el('p', null, opts.literalHtml)
        markdown.appendChild(paragraph)
      }
      body.appendChild(markdown)
      var reasoning = el('div', {})
      var think = el('div', { 'data-variant': 'think', class: 'fake-think' })
      think.textContent = '思考块 <b>不应解析</b>'
      reasoning.appendChild(think)
      body.appendChild(reasoning)
      var hidden = el('div', { 'data-turn-process-inline': '' })
      hidden.setAttribute('hidden', '')
      hidden.textContent = '隐藏的折叠过程'
      body.appendChild(hidden)
      root.appendChild(body)
      anchor.appendChild(root)
      flow.appendChild(anchor)
      render.think = think
      render.reasoningWrapper = reasoning
      render.hidden = hidden
      return render
    }

    var settled = buildAssistantRow({
      textInteractionSource: true,
      markdown: '助手 **回复**\n\n| 列1 | 列2 |\n| - | - |\n| a | b |',
      literalHtml: '内嵌 HTML：<b>粗体</b> 与 <kbd>Ctrl</kbd>',
    })
    var wideHolder = el('div')
    wideHolder.innerHTML = '<div class="tableScroll md-table-wide"><table><thead><tr>'
      + new Array(12).fill('<th>宽列</th>').join('')
      + '</tr></thead><tbody><tr>' + new Array(12).fill('<td>值</td>').join('') + '</tr></tbody></table></div>'
    settled.markdown.appendChild(wideHolder)
    var codeBlock = el('div', { class: 'md-code-block' })
    var banner = el('div', { 'data-code-block-banner': '' }, 'javascript · 复制')
    banner.style.position = 'sticky'
    banner.style.top = '0px'
    var codeContent = el('div', { 'data-code-block-content': '' })
    codeContent.innerHTML = '<pre><code>const x = 1</code></pre>'
    codeBlock.append(banner, codeContent)
    settled.markdown.appendChild(codeBlock)

    var streaming = buildAssistantRow({
      streaming: true,
      markdown: '流式 **生成中**',
      literalHtml: '流式字面 <b>暂不处理</b>',
    })

    var reasoningHiddenRow = buildAssistantRow({ reasoningOnly: true, hidden: true })
    var emptyStreamingRow = buildAssistantRow({ streaming: true, empty: true })
    var groupReasoningRow = buildAssistantRow({ textInteractionSource: true, markdown: '分区正文 **不应有气泡**', groupPart: 'reasoning' })

    var userFlow = el('div', { 'data-chat-flow-kind': 'user' })
    var userColumn = el('div')
    var bubble = el('div', { 'data-message-bubble': '' })
    var userMarkdown = el('div', { 'data-dsh-md': 'user', class: 'dsh-md-user' })
    userMarkdown.innerHTML = api.renderUserMarkdown('用户 **消息**：`code`\n\n- 列表')
    bubble.appendChild(userMarkdown)
    userColumn.appendChild(bubble)
    userFlow.appendChild(userColumn)

    var toolFlow = el('div', { 'data-chat-flow-kind': 'tool-call' })
    toolFlow.innerHTML = '<div class="tool-card"><button type="button">复制</button></div>'
    var thinkFlow = el('div', { 'data-variant': 'think' })
    thinkFlow.textContent = '独立思考行'

    stage.append(
      userFlow, settled.flow, streaming.flow, toolFlow, thinkFlow,
      reasoningHiddenRow.flow, emptyStreamingRow.flow, groupReasoningRow.flow,
    )

    var button = toolFlow.querySelector('button')
    var clicks = 0
    button.addEventListener('click', function () { clicks += 1 })

    function rowLayoutSnapshot(node) {
      var style = window.getComputedStyle(node)
      return {
        display: style.display,
        justifyContent: style.justifyContent,
        alignItems: style.alignItems,
        flexDirection: style.flexDirection,
        padding: style.padding,
        background: style.backgroundColor,
      }
    }
    function thinkSnapshot(node) {
      var style = window.getComputedStyle(node)
      return { display: style.display, padding: style.padding, border: style.border, background: style.backgroundColor, margin: style.margin }
    }

    var beforeTool = window.getComputedStyle(toolFlow.querySelector('.tool-card'))
    var beforeButton = window.getComputedStyle(button)
    var beforeRows = [rowLayoutSnapshot(userFlow), rowLayoutSnapshot(settled.flow), rowLayoutSnapshot(streaming.flow)]
    var beforeThink = [thinkSnapshot(settled.think), thinkSnapshot(settled.hidden), thinkSnapshot(thinkFlow)]

    var ctx = createFakeCtx()
    var dispose = plugin.apply(ctx)

    await check('apply/样式与槽注册', function () {
      assertEqual(document.documentElement.getAttribute('data-dsh-md-session'), 'on', '根属性缺失')
      assert(document.querySelector('style[data-plugin="dsh-markdown-session"]') !== null, '样式未注入')
      assert(ctx.slot !== null, '槽未注册')
      assertEqual(ctx.slot.options.name, 'conversation.user.text.node', '槽名')
      assertEqual(ctx.slot.options.key, 'text', '槽 key')
      assertEqual(ctx.slot.options.priority, api.SHADOW_PRIORITY, '槽 priority')
      assert(ctx.slot.options.priority < 100, 'priority 必须低于上游 100')
      assertEqual(typeof ctx.slot.component, 'function', '槽组件')
    })

    await check('气泡/流式态（无 settled 属性）也有气泡外壳', function () {
      var rootStyle = window.getComputedStyle(streaming.root)
      assert(colorOf(rootStyle.backgroundColor) !== null, '流式消息无气泡背景')
      assert(parseFloat(rootStyle.borderRadius) > 0, '流式消息无圆角')
      assert(parseFloat(rootStyle.paddingLeft) > 0, '流式消息无内边距')
      assert(streaming.markdown.getAttribute('data-text-interaction-source') === null, '流式分支不应有 settled 属性')
      // 流式期间后处理必须不动：字面 HTML 仍是文本
      assertEqual(streaming.markdown.querySelector('b'), null, '流式消息被后处理（错误）')
      assert(streaming.markdown.textContent.indexOf('<b>暂不处理</b>') >= 0, '流式字面 HTML 文本被改')
    })

    await check('气泡/无可见正文不出空气泡（reasoning-only / 组分区 reasoning / 空流式）', function () {
      var cases = [
        ['reasoning-hidden', reasoningHiddenRow.root],
        ['empty-streaming', emptyStreamingRow.root],
        ['group-part-reasoning', groupReasoningRow.root],
      ]
      for (var index = 0; index < cases.length; index++) {
        var style = window.getComputedStyle(cases[index][1])
        var background = colorOf(style.backgroundColor)
        assert(background === null || background.a === 0, cases[index][0] + ' 出现空气泡背景')
        assertEqual(parseFloat(style.borderRadius), 0, cases[index][0] + ' 出现气泡圆角')
        assertEqual(parseFloat(style.paddingLeft), 0, cases[index][0] + ' 出现气泡内边距')
      }
      // 对照组：同一结构里只要有可见 MarkdownText 正文就必须有气泡（已在流式/落定断言里覆盖）。
    })

    await check('气泡/落定态：外壳在消息根而不是 Markdown 根', function () {
      var rootStyle = window.getComputedStyle(settled.root)
      var markdownStyle = window.getComputedStyle(settled.markdown)
      assert(colorOf(rootStyle.backgroundColor) !== null, '落定消息无气泡背景')
      assert(parseFloat(rootStyle.borderRadius) > 0, '落定消息无圆角')
      assertEqual(colorOf(markdownStyle.backgroundColor).a, 0, '气泡被错误地加在 Markdown 根上')
      assert(settled.root.contains(settled.think), '气泡未覆盖思考块子块')
      assert(settled.root.contains(settled.hidden), '气泡未覆盖折叠过程子块')
      // settled 后处理仍生效（选择器保持 [data-text-interaction-source]）
      assert(settled.markdown.querySelector('b') !== null, '落定消息后处理失效')
      assert(settled.markdown.querySelector('kbd') !== null, '落定消息 kbd 未渲染')
    })

    await check('气泡/内部 .body gap 与思考块、折叠隐藏不受影响', function () {
      assertEqual(window.getComputedStyle(settled.body).rowGap, '16px', '.body gap 被破坏')
      var afterThink = [thinkSnapshot(settled.think), thinkSnapshot(settled.hidden), thinkSnapshot(thinkFlow)]
      for (var index = 0; index < afterThink.length; index++) {
        assertEqual(JSON.stringify(afterThink[index]), JSON.stringify(beforeThink[index]), '思考/隐藏子块样式被改变 #' + index)
      }
      assertEqual(window.getComputedStyle(settled.hidden).display, 'none', '折叠隐藏失效')
    })

    await check('气泡/sticky 代码 banner 未被 transform/overflow 破坏', function () {
      var bannerStyle = window.getComputedStyle(banner)
      var rootStyle = window.getComputedStyle(settled.root)
      assertEqual(bannerStyle.position, 'sticky', '代码 banner 不再是 sticky')
      assertEqual(rootStyle.overflow, 'visible', '气泡根设置了 overflow（会破坏 sticky）')
      assertEqual(rootStyle.transform, 'none', '气泡根设置了 transform（会破坏 sticky）')
    })

    await check('表格/宽表在气泡内滚动且页面不横向撑破', function () {
      var wrapper = settled.markdown.querySelector('.md-table-wide')
      assert(wrapper !== null, '缺宽表')
      var style = window.getComputedStyle(wrapper)
      assertEqual(style.overflowX, 'auto', '宽表未横向滚动')
      assert(wrapper.scrollWidth > wrapper.clientWidth, '宽表未产生内部滚动：' + wrapper.scrollWidth + '/' + wrapper.clientWidth)
      assert(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面被宽表撑破：' + document.documentElement.scrollWidth + ' > ' + window.innerWidth)
    })

    await check('行容器/不注入无效布局属性（用户右/助手左由上游自身提供）', function () {
      var afterRows = [rowLayoutSnapshot(userFlow), rowLayoutSnapshot(settled.flow), rowLayoutSnapshot(streaming.flow)]
      for (var index = 0; index < afterRows.length; index++) {
        assertEqual(JSON.stringify(afterRows[index]), JSON.stringify(beforeRows[index]), '行容器布局被插件改动 #' + index)
      }
      var styleText = document.querySelector('style[data-plugin="dsh-markdown-session"]').textContent
      assertEqual(styleText.indexOf('justify-content'), -1, '样式里仍向行容器注入 justify-content')
      // 右/左对齐来自上游结构（用户行块级满宽 + align-items:flex-end；助手根在 .body 内左起）。
      var bubbleRect = bubble.getBoundingClientRect()
      var userRowRect = userFlow.getBoundingClientRect()
      assert(Math.abs(bubbleRect.right - userRowRect.right) <= 2, '用户气泡未右对齐：' + bubbleRect.right + ' vs ' + userRowRect.right)
      var settledRect = settled.root.getBoundingClientRect()
      var assistantRowRect = settled.flow.getBoundingClientRect()
      assert(Math.abs(settledRect.left - assistantRowRect.left) <= 2, '助手气泡未左对齐：' + settledRect.left + ' vs ' + assistantRowRect.left)
    })

    await check('气泡/浅色对比度（用户与助手、流式与落定）', function () {
      var user = textContrast(userMarkdown, bubble)
      var settledLight = textContrast(settled.markdown, settled.root)
      var streamingLight = textContrast(streaming.markdown, streaming.root)
      assert(user.ratio >= 4.5, '浅色用户气泡对比度不足：' + user.ratio.toFixed(2))
      assert(settledLight.ratio >= 4.5, '浅色落定助手气泡对比度不足：' + settledLight.ratio.toFixed(2))
      assert(streamingLight.ratio >= 4.5, '浅色流式气泡对比度不足：' + streamingLight.ratio.toFixed(2))
      window.__lightContrast = user.ratio
      window.__assistantLightContrast = Math.min(settledLight.ratio, streamingLight.ratio)
    })

    await check('气泡/深色主题可读（用户与助手、流式与落定）', function () {
      document.body.setAttribute('data-ds-dark-theme', '')
      var user = textContrast(userMarkdown, bubble)
      var settledDark = textContrast(settled.markdown, settled.root)
      var streamingDark = textContrast(streaming.markdown, streaming.root)
      assert(user.ratio >= 4.5, '深色用户气泡对比度不足：' + user.ratio.toFixed(2))
      assert(settledDark.ratio >= 4.5, '深色落定助手气泡对比度不足：' + settledDark.ratio.toFixed(2))
      assert(streamingDark.ratio >= 4.5, '深色流式气泡对比度不足：' + streamingDark.ratio.toFixed(2))
      window.__darkContrast = {
        user: user.ratio,
        assistant: Math.min(settledDark.ratio, streamingDark.ratio),
      }
      document.body.removeAttribute('data-ds-dark-theme')
    })

    await check('不回归/工具卡与按钮样式点击不受影响', function () {
      var afterTool = window.getComputedStyle(toolFlow.querySelector('.tool-card'))
      var afterButton = window.getComputedStyle(button)
      for (var property of ['backgroundColor', 'display', 'borderRadius', 'color', 'fontSize', 'padding', 'position']) {
        assertEqual(afterTool[property], beforeTool[property], '工具卡 ' + property + ' 被改变')
        assertEqual(afterButton[property], beforeButton[property], '按钮 ' + property + ' 被改变')
      }
      button.click()
      assertEqual(clicks, 1, '按钮点击失效')
    })

    var second = null
    await check('观察器/新落定消息被去抖处理（流式仍跳过）', async function () {
      second = buildAssistantRow({ textInteractionSource: true, literalHtml: '新消息 <b>粗</b>' })
      stage.appendChild(second.flow)
      var streamingLate = buildAssistantRow({ streaming: true, literalHtml: '后到流式 <b>不处理</b>' })
      stage.appendChild(streamingLate.flow)
      await wait(500)
      assert(second.markdown.querySelector('b') !== null, 'MutationObserver 未处理新落定消息')
      assertEqual(streamingLate.markdown.querySelector('b'), null, 'MutationObserver 处理了流式消息（错误）')
      window.__second = second
      window.__streamingLate = streamingLate
    })

    await check('卸载/恢复原样且不再处理新消息', async function () {
      dispose()
      assertEqual(document.documentElement.getAttribute('data-dsh-md-session'), null, '根属性未移除')
      assert(document.querySelector('style[data-plugin="dsh-markdown-session"]') === null, '样式未移除')
      assertEqual(ctx.slot, null, '槽注册未撤销')
      assertEqual(window.__second.markdown.textContent, '新消息 <b>粗</b>', '已替换内容未还原')
      var after = buildAssistantRow({ textInteractionSource: true, literalHtml: '卸载后 <b>不应处理</b>' })
      stage.appendChild(after.flow)
      await wait(500)
      assertEqual(after.markdown.querySelector('b'), null, '卸载后仍处理新消息（监听未摘除）')
      // 流式文字在卸载前就不该被处理
      assertEqual(window.__streamingLate.markdown.querySelector('b'), null, '流式文字被处理')
      window.__second = null
      window.__streamingLate = null
    })


    /* ---- 6. 报告 ---- */
    var failures = results.filter(function (item) { return !item.ok })
    return {
      total: results.length,
      failed: failures.length,
      xssPayloads: payloads.length,
      lightContrast: window.__lightContrast,
      assistantLightContrast: window.__assistantLightContrast,
      darkContrast: window.__darkContrast,
      results: results,
    }
  }

  run().then(function (summary) {
    var text = JSON.stringify(summary).replace(/</g, '\\u003c')
    output.textContent = text
  }, function (error) {
    var text = JSON.stringify({
      total: results.length,
      failed: results.filter(function (item) { return !item.ok }).length,
      fatal: String((error && error.stack) || error),
      results: results,
    }).replace(/</g, '\\u003c')
    output.textContent = text
  })
}())
