/**
 * dsh-markdown-session — 真浏览器测试入口（无头 Chrome）。
 *
 * 为什么不是 jsdom：DOMPurify 依赖真实 HTML 解析/命名空间/序列化语义，jsdom 不是
 * 等价物；本仓库不引入重量级测试依赖，直接驱动本机 Chrome：
 *   --headless=new --no-sandbox --dump-dom <harness.html>
 * 页面把结构化结果写进 <pre id="e2e-results">，这里解析并断言。
 *
 * 找不到 Chrome 时跳过（而不是失败），并打印原因；本机验收会实际跑通。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'test/.tmp')
const ARTIFACTS = join(ROOT, 'test/artifacts')

function findChrome() {
  const candidates = [
    process.env.DSH_CHROME_PATH,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const CHROME = findChrome()
const SKIP_REASON = CHROME === null ? '未找到 Chrome（设置 DSH_CHROME_PATH 后可跑真浏览器用例）' : false

function chromeArgs(profile) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--user-data-dir=' + profile,
  ]
}

function freshProfile(name) {
  const profile = join(TMP, 'chrome-' + name + '-' + process.pid)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  return profile
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

test('浏览器 E2E：XSS 零执行 / GFM 渲染 / 助手 HTML 后处理 / 气泡与卸载', { skip: SKIP_REASON }, () => {
  mkdirSync(TMP, { recursive: true })
  const profile = freshProfile('e2e')
  const harness = pathToFileURL(join(ROOT, 'test/fixtures/harness.html')).href
  const stdout = execFileSync(CHROME, [
    ...chromeArgs(profile),
    '--virtual-time-budget=20000',
    '--window-size=1100,900',
    '--dump-dom',
    harness,
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  rmSync(profile, { recursive: true, force: true })

  const match = stdout.match(/<pre id="e2e-results"[^>]*>([\s\S]*?)<\/pre>/)
  assert.ok(match, '页面没有输出 e2e-results（脚本可能未执行）')
  const payload = decodeHtmlEntities(match[1]).trim()
  let summary
  try {
    summary = JSON.parse(payload)
  } catch (error) {
    assert.fail('e2e-results JSON 解析失败: ' + payload.slice(0, 400))
  }
  const failures = (summary.results || []).filter((item) => !item.ok)
  assert.equal(summary.fatal, undefined, 'E2E 顶层异常: ' + (summary.fatal || ''))
  assert.equal(failures.length, 0, '失败用例:\n' + failures.map((item) => item.name + ' => ' + item.error).join('\n'))
  assert.ok(summary.total >= 40, 'E2E 断言数量异常: ' + summary.total)
  assert.ok(summary.xssPayloads >= 30, 'XSS payload 数量不足: ' + summary.xssPayloads)
  assert.ok(summary.lightContrast >= 4.5, '浅色用户气泡对比度不足')
  assert.ok(summary.assistantLightContrast >= 4.5, '浅色助手气泡对比度不足')
  assert.ok(summary.darkContrast.user >= 4.5, '深色用户气泡对比度不足')
  assert.ok(summary.darkContrast.assistant >= 4.5, '深色助手气泡对比度不足')
  process.stdout.write(
    '[browser-e2e] checks=' + summary.total
    + ' xss_payloads=' + summary.xssPayloads
    + ' light=' + summary.lightContrast.toFixed(2) + '/' + summary.assistantLightContrast.toFixed(2)
    + ' dark=' + summary.darkContrast.user.toFixed(2) + '/' + summary.darkContrast.assistant.toFixed(2)
    + '\n',
  )
})

test('视觉证据：浅色/深色气泡截图', { skip: SKIP_REASON }, () => {
  mkdirSync(ARTIFACTS, { recursive: true })
  const outputs = []
  for (const theme of ['light', 'dark']) {
    const profile = freshProfile('shot-' + theme)
    const target = join(ARTIFACTS, 'bubbles-' + theme + '.png')
    rmSync(target, { force: true })
    const url = pathToFileURL(join(ROOT, 'test/fixtures/visual.html')).href + '?theme=' + theme
    execFileSync(CHROME, [
      ...chromeArgs(profile),
      '--virtual-time-budget=5000',
      '--window-size=1100,1250',
      '--screenshot=' + target,
      url,
    ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    rmSync(profile, { recursive: true, force: true })
    assert.ok(existsSync(target), '截图未生成: ' + target)
    const buffer = readFileSync(target)
    assert.ok(buffer.length > 10 * 1024, '截图体积异常: ' + buffer.length)
    assert.equal(buffer.readUInt32BE(0), 0x89504e47, '不是 PNG')
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    assert.equal(width, 1100, '截图宽度异常: ' + width)
    assert.ok(height >= 900, '截图高度异常: ' + height)
    outputs.push(theme + '=' + buffer.length + 'B/' + width + 'x' + height)
  }
  process.stdout.write('[visual] ' + outputs.join(' ') + '\n')
})
