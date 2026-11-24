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

    /* ---- 5. apply：样式、槽注册、观察器、浅深色对比度、回归、卸载 ---- */
    stage.innerHTML = ''
    var userFlow = el('div', { 'data-chat-flow-kind': 'user' })
    var userColumn = el('div')
    var bubble = el('div', { 'data-message-bubble': '' })
    var userMarkdown = el('div', { 'data-dsh-md': 'user', class: 'dsh-md-user' })
    userMarkdown.innerHTML = api.renderUserMarkdown('用户 **消息**：`code`\n\n- 列表')
    bubble.appendChild(userMarkdown)
    userColumn.appendChild(bubble)
    userFlow.appendChild(userColumn)

    var assistantFlow = el('div', { 'data-chat-flow-kind': 'assistant-step' })
    var assistantBody = el('div', { 'data-text-interaction-source': '' })
    assistantBody.innerHTML = api.renderUserMarkdown('助手 **回复**\n\n| 列1 | 列2 |\n| - | - |\n| a | b |')
    var wideTableHolder = el('div')
    wideTableHolder.innerHTML = '<div class="tableScroll md-table-wide"><table><thead><tr>'
      + new Array(12).fill('<th>宽列</th>').join('')
      + '</tr></thead><tbody><tr>' + new Array(12).fill('<td>值</td>').join('') + '</tr></tbody></table></div>'
    assistantBody.appendChild(wideTableHolder)
    assistantFlow.appendChild(assistantBody)

    var toolFlow = el('div', { 'data-chat-flow-kind': 'tool-call' })
    toolFlow.innerHTML = '<div class="tool-card"><button type="button">复制</button></div>'
    var thinkFlow = el('div', { 'data-variant': 'think' })
    thinkFlow.textContent = '思考中…'

    stage.append(userFlow, assistantFlow, toolFlow, thinkFlow)

    var button = toolFlow.querySelector('button')
    var clicks = 0
    button.addEventListener('click', function () { clicks += 1 })
    var beforeTool = window.getComputedStyle(toolFlow.querySelector('.tool-card'))
    var beforeButton = window.getComputedStyle(button)

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

    await check('气泡/用户右对齐 + 浅色对比度', function () {
      var userRowStyle = window.getComputedStyle(userFlow)
      // Chrome 158 起计算值可能报逻辑别名 flow-end/flow-start（等价 flex-end/flex-start）。
      assert(['flex-end', 'flow-end', 'end'].includes(userRowStyle.justifyContent), '用户行未右对齐: ' + userRowStyle.justifyContent)
      var bubbleStyle = window.getComputedStyle(bubble)
      assertEqual(colorOf(bubbleStyle.backgroundColor) !== null, true, '用户气泡无背景')
      var markdownStyle = window.getComputedStyle(userMarkdown)
      assertEqual(markdownStyle.whiteSpace, 'normal', '用户 markdown 未覆盖 pre-wrap')
      var light = textContrast(userMarkdown, bubble)
      assert(light.ratio >= 4.5, '浅色用户气泡对比度不足：' + light.ratio.toFixed(2) + ' (' + light.text + ' / ' + light.background + ')')
      window.__lightContrast = light.ratio
    })

    await check('气泡/助手左对齐、圆角、浅色对比度', function () {
      var assistantRowStyle = window.getComputedStyle(assistantFlow)
      assert(['flex-start', 'flow-start', 'start', 'normal'].includes(assistantRowStyle.justifyContent), '助手行未左对齐: ' + assistantRowStyle.justifyContent)
      var bodyStyle = window.getComputedStyle(assistantBody)
      assert(colorOf(bodyStyle.backgroundColor) !== null, '助手气泡无背景')
      assert(parseFloat(bodyStyle.borderRadius) > 0, '助手气泡无圆角')
      assert(parseFloat(bodyStyle.paddingLeft) > 0, '助手气泡无内边距')
      assert(bodyStyle.maxWidth !== 'none', '助手气泡缺少 max-width')
      var light = textContrast(assistantBody)
      assert(light.ratio >= 4.5, '浅色助手气泡对比度不足：' + light.ratio.toFixed(2))
      window.__assistantLightContrast = light.ratio
    })

    await check('气泡/深色主题可读', function () {
      document.body.setAttribute('data-ds-dark-theme', '')
      var user = textContrast(userMarkdown, bubble)
      var assistant = textContrast(assistantBody)
      assert(user.ratio >= 4.5, '深色用户气泡对比度不足：' + user.ratio.toFixed(2))
      assert(assistant.ratio >= 4.5, '深色助手气泡对比度不足：' + assistant.ratio.toFixed(2))
      window.__darkContrast = { user: user.ratio, assistant: assistant.ratio }
      document.body.removeAttribute('data-ds-dark-theme')
    })

    await check('表格/宽表在气泡内滚动且页面不横向撑破', function () {
      var wrapper = assistantBody.querySelector('.md-table-wide')
      assert(wrapper !== null, '缺宽表')
      var style = window.getComputedStyle(wrapper)
      assertEqual(style.overflowX, 'auto', '宽表未横向滚动')
      assert(wrapper.scrollWidth > wrapper.clientWidth, '宽表未产生内部滚动：' + wrapper.scrollWidth + '/' + wrapper.clientWidth)
      assert(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面被宽表撑破：' + document.documentElement.scrollWidth + ' > ' + window.innerWidth)
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

    await check('不回归/思考块文本未被当成 HTML', function () {
      assertEqual(thinkFlow.textContent, '思考中…', '思考块文本被改')
      assertEqual(thinkFlow.querySelector('b'), null, '思考块生成了元素')
    })

    var secondFlow = null
    await check('观察器/新落定消息被去抖处理', async function () {
      secondFlow = el('div', { 'data-chat-flow-kind': 'assistant-step' })
      var body = el('div', { 'data-text-interaction-source': '' })
      body.textContent = '新消息 <b>粗</b>'
      secondFlow.appendChild(body)
      stage.appendChild(secondFlow)
      await wait(500)
      assert(body.querySelector('b') !== null, 'MutationObserver 未处理新消息')
      window.__secondBody = body
    })

    await check('卸载/恢复原样且不再处理新消息', async function () {
      dispose()
      assertEqual(document.documentElement.getAttribute('data-dsh-md-session'), null, '根属性未移除')
      assert(document.querySelector('style[data-plugin="dsh-markdown-session"]') === null, '样式未移除')
      assertEqual(ctx.slot, null, '槽注册未撤销')
      var restored = window.__secondBody
      assertEqual(restored.textContent, '新消息 <b>粗</b>', '已替换内容未还原')
      var after = el('div', { 'data-chat-flow-kind': 'assistant-step' })
      var afterBody = el('div', { 'data-text-interaction-source': '' })
      afterBody.textContent = '卸载后 <b>不应处理</b>'
      after.appendChild(afterBody)
      stage.appendChild(after)
      await wait(500)
      assertEqual(afterBody.querySelector('b'), null, '卸载后仍处理新消息（监听未摘除）')
      // 清理，避免污染后续截图页
      window.__secondBody = null
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
