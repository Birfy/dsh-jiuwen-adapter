#!/usr/bin/env node
// Generate a dsh plugin-market index (format 1) for this bundle.
//
//   node scripts/market-index.mjs                 # git source pinned to HEAD
//   node scripts/market-index.mjs --commit <sha>  # pin a specific commit
//   node scripts/market-index.mjs --source npm    # after `npm publish`
//
// Writes market/index.json and market/icon.svg (the icon resolves relative to
// the index URL). When @deepseek-ai/dsh-plugin-market-index is resolvable
// (via DSH_NM or normal resolution) the document is validated with the
// official parser and the script exits non-zero on any error.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const out = resolve(arg('--out', join(root, 'market')))
const sourceType = arg('--source', 'git')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

export function buildIndex ({ commit, timestamp }) {
  const source = sourceType === 'npm'
    ? { type: 'npm' }
    : { type: 'git', url: repoUrl, commit }
  return {
    format: 1,
    title: { en: 'JiuwenSwarm for dsh', zh: 'JiuwenSwarm dsh 插件' },
    description: { en: 'Index for the JiuwenSwarm LLM adapter bundle.' },
    metadata: {
      categories: { agents: { title: { en: 'Agents', zh: '智能体' } } },
      labels: { 'compat-tested': { title: { en: 'Compatibility-tested', zh: '兼容性已测' } } }
    },
    plugins: [{
      name: pkg.name,
      title: { en: 'JiuwenSwarm Adapter', zh: 'JiuwenSwarm 适配器' },
      description: { en: pkg.description },
      icon: 'icon.svg',
      author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
      homepage: pkg.homepage,
      repository: { url: repoUrl },
      metadata: {
        category: 'agents',
        keywords: ['jiuwen', 'jiuwenswarm', 'llm-provider', 'multi-agent', 'gateway'],
        labels: ['compat-tested']
      },
      versions: [{
        version: pkg.version,
        publishTimestamp: timestamp,
        source,
        engines: { dsh: pkg.engines.dsh }
      }]
    }]
  }
}

async function loadParser () {
  const spec = '@deepseek-ai/dsh-plugin-market-index'
  const bases = [process.env.DSH_NM, join(root, 'node_modules')].filter(Boolean)
  for (const b of bases) {
    try { return (await import(pathToFileURL(join(b, spec, 'lib', 'index.js')).href)).parseMarketIndex } catch {}
  }
  try { return (await import(spec)).parseMarketIndex } catch { return null }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commit = arg('--commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const timestamp = Number(execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: root, encoding: 'utf8' }).trim())
  const index = buildIndex({ commit: execFileSync('git', ['rev-parse', commit], { cwd: root, encoding: 'utf8' }).trim(), timestamp })
  const parse = await loadParser()
  if (parse) {
    try { parse(index, 'https://example.invalid/market/index.json') } catch (e) {
      console.error(`invalid index: ${e.path ?? ''} ${e.reason ?? e.message}`); process.exit(1)
    }
    console.log('validated with @deepseek-ai/dsh-plugin-market-index')
  } else console.log('parser not found; skipped validation (set DSH_NM)')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  copyFileSync(join(root, pkg.icon), join(out, 'icon.svg'))
  console.log(`wrote ${join(out, 'index.json')} (${sourceType} source${sourceType === 'git' ? ' @ ' + index.plugins[0].versions[0].source.commit.slice(0, 7) : ''})`)
}
