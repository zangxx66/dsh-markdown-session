/**
 * dsh-markdown-session — 包结构 / DSH 插件规范一致性断言（判据 12）。
 *
 * plugin_manager 的真实安装扫描需要运行中的 profile（本 attempt 沙箱不可写
 * ~/.dsh/profile），这里按 loader 实际读取的字段做结构断言：清单、patch、双半边
 * 导出、locale、icon、LICENSE、vendor 许可证与产物注册 id。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('清单声明可被 DSH loader / plugin_manager 识别', () => {
  assert.equal(pkg.name, 'dsh-markdown-session')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(pkg.files.includes('locale'))
  assert.ok(pkg.files.includes('icon.svg'))
})

test('dsh 双半边声明完整：bundle.patch + client.platform=web + external react', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.external.includes('react'), 'client 半区需要 react 静态模块')
})

test('cordis.patch.yml 以 insert 方式登记同名插件 id', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^-\s*insert:/m)
  assert.match(patch, /id:\s*dsh-markdown-session/)
  assert.match(patch, /name:\s*'dsh-markdown-session'/)
})

test('宿主半区导出 name / inject / apply', async () => {
  const host = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  assert.equal(host.name, 'dsh-markdown-session')
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.apply, 'function')
})

test('客户端半区产物：注册 id 与包名一致、内联 vendor、只 require react', () => {
  const bundle = read('client.js')
  assert.ok(bundle.includes('window.__ModuleLoader__.load({'))
  assert.ok(bundle.includes('id: "dsh-markdown-session"'))
  assert.ok(bundle.includes('factory: function (require)'))
  assert.ok(bundle.includes('require("react")'))
  assert.ok(bundle.includes('marked v16.4.2'))
  assert.ok(bundle.includes('DOMPurify 3.4.17'))
  const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], '客户端产物不得 require 其它裸包')
})

test('locale 字典存在且 zh/en 键集合一致', () => {
  const zh = JSON.parse(read('locale/zh.json'))
  const en = JSON.parse(read('locale/en.json'))
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(zh).length > 0)
  for (const value of Object.values(zh)) assert.equal(typeof value, 'string')
  for (const value of Object.values(en)) assert.equal(typeof value, 'string')
})

test('icon / LICENSE / README / vendor 许可证齐全', () => {
  const icon = read('icon.svg')
  assert.match(icon, /^<svg[\s>]/)
  assert.match(read('LICENSE'), /MIT License/)
  const readme = read('README.md')
  assert.match(readme, /## 安装/)
  assert.match(readme, /## 第三方/)
  assert.ok(existsSync(join(ROOT, 'vendor/marked.umd.cjs')))
  assert.ok(existsSync(join(ROOT, 'vendor/marked.LICENSE.md')))
  assert.ok(existsSync(join(ROOT, 'vendor/purify.cjs.js')))
  assert.ok(existsSync(join(ROOT, 'vendor/purify.LICENSE')))
  assert.match(read('vendor/marked.LICENSE.md'), /MIT license/i)
  assert.match(read('vendor/purify.LICENSE'), /Apache License/)
})

test('files 清单中的每个条目都真实存在', () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(ROOT, entry)), 'package.json files 里的 ' + entry + ' 不存在')
  }
})
