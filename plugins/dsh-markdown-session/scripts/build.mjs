#!/usr/bin/env node
/**
 * dsh-markdown-session — client bundle builder.
 *
 * 浏览器模块表只共享 11 个静态模块，loader 不解析 bare 包，因此 marked 与
 * DOMPurify 必须内联进 client.js。本脚本不依赖 esbuild/rollup：
 *   - 读 vendor/*.js（marked UMD、DOMPurify CJS）
 *   - 读 lib/markdown-session.cjs（UMD 工厂）
 *   - 用局部 module 包一层，拼成 classic script：
 *       window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *   - factory 内 require('react') 由宿主静态模块表提供。
 *
 * 产物是生成文件，不要手改；改代码请改 lib/ 与 vendor/ 后重跑 npm run build。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = PKG.name

function readSource(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

function stripSourceMapComment(source) {
  return source.replace(/^\/\/# sourceMappingURL=.*$/gm, '').trimEnd()
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

const markedSource = stripSourceMapComment(readSource('vendor/marked.umd.cjs'))
const purifySource = stripSourceMapComment(readSource('vendor/purify.cjs.js'))
const coreSource = readSource('lib/markdown-session.cjs')

if (!markedSource.includes('marked v')) throw new Error('vendor/marked.umd.cjs 不是预期构建（缺少版本文档头）')
if (!purifySource.includes('DOMPurify 3')) throw new Error('vendor/purify.cjs.js 不是预期构建（缺少版本文档头）')
if (!coreSource.includes('createMarkdownSessionModule')) throw new Error('lib/markdown-session.cjs 缺少工厂入口')
if (/<\/script/i.test(coreSource)) throw new Error('lib/markdown-session.cjs 含 </script 序列，不能内联进 classic script')

const markedVersion = (markedSource.match(/marked v(\d+\.\d+\.\d+)/) ?? [, 'unknown'])[1]
const purifyVersion = (purifySource.match(/DOMPurify (\d+\.\d+\.\d+)/) ?? [, 'unknown'])[1]

const lines = [
  '/**',
  ' * ' + PLUGIN_ID + ' — 浏览器半边（GENERATED FILE，勿手改）。',
  ' * 由 scripts/build.mjs 生成：marked ' + markedVersion + ' (MIT) + DOMPurify ' + purifyVersion + ' (Apache-2.0/MPL-2.0) 内联。',
  ' * vendor 指纹：marked=' + sha256(markedSource) + ' purify=' + sha256(purifySource) + ' core=' + sha256(coreSource) + '。',
  ' * 许可证：见 vendor/marked.LICENSE.md、vendor/purify.LICENSE 与 README「第三方」小节。',
  ' */',
  'window.__ModuleLoader__.load({',
  '  id: ' + JSON.stringify(PLUGIN_ID) + ',',
  '  factory: function (require) {',
  '    "use strict";',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    var React = require("react");',
  '    var marked = (function () {',
  '      var module = { exports: {} };',
  '      var exports = module.exports;',
  markedSource,
  '      return module.exports;',
  '    })();',
  '    var DOMPurify = (function () {',
  '      var module = { exports: {} };',
  '      var exports = module.exports;',
  purifySource,
  '      return module.exports;',
  '    })();',
  '    var createMarkdownSession = (function () {',
  '      var module = { exports: {} };',
  '      var exports = module.exports;',
  coreSource,
  '      return module.exports;',
  '    })();',
  '    var session = createMarkdownSession({',
  '      React: React,',
  '      marked: marked,',
  '      DOMPurify: DOMPurify,',
  '      document: window.document,',
  '      window: window,',
  '      MutationObserver: window.MutationObserver',
  '    });',
  '    return session.plugin;',
  '  }',
  '});',
  '',
]

const output = lines.join('\n')
const target = join(ROOT, 'client.js')
writeFileSync(target, output)
process.stdout.write(
  '[build] client.js ' + Buffer.byteLength(output) + ' bytes'
  + ' (marked ' + markedVersion + ', dompurify ' + purifyVersion + ')\n',
)
