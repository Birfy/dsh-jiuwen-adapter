import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const index = JSON.parse(readFileSync(join(root, 'market', 'index.json'), 'utf8'))
const nm = process.env.DSH_NM ?? '/workspace/fb-busyack3/core/dev/harness/node_modules'
const parserPath = join(nm, '@deepseek-ai/dsh-plugin-market-index/lib/index.js')

test('market index matches package.json', () => {
  const p = index.plugins[0]
  assert.equal(p.name, pkg.name)
  assert.equal(p.versions[0].version, pkg.version)
  assert.equal(p.versions[0].engines.dsh, pkg.engines.dsh)
  assert.match(p.versions[0].source.commit ?? '', /^[0-9a-f]{40}$/)
  assert.ok(existsSync(join(root, 'market', p.icon)))
})

test('market index passes the official parser', { skip: !existsSync(parserPath) && 'dsh-plugin-market-index not installed' }, async () => {
  const { parseMarketIndex } = await import(pathToFileURL(parserPath).href)
  const parsed = parseMarketIndex(index, 'https://raw.githubusercontent.com/hsliuustc0106/dsh-jiuwen-adapter/main/market/index.json')
  assert.equal(parsed.plugins[0].name, pkg.name)
  assert.ok(parsed.plugins[0].icon.endsWith('/market/icon.svg'))
})
