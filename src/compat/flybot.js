/**
 * OPTIONAL FlyBot compatibility glue. The core adapter never imports FlyBot
 * code paths directly; plugin.js consults this module only when
 *   config.compat === 'flybot'  |  JIUWEN_COMPAT=flybot
 * or (compat 'auto', the default) when a FlyBot checkout is detected on disk.
 * Set compat: 'none' / JIUWEN_COMPAT=none to disable entirely.
 *
 * What lives here (and only here):
 *   - Known FlyBot monorepo locations of @deepseek-ai/dsh-llm / cordis, used as
 *     extra resolution candidates for the LlmAdapter base class.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'flybot'

export function flybotRoot(env = process.env) {
  return env.FLYBOT_ROOT || '/workspace/FlyBot'
}

export function flybotPaths(env = process.env) {
  const harness = join(flybotRoot(env), 'deepseek-harness')
  return {
    harness,
    llm: join(harness, 'packages/llm/llm/lib/index.js'),
    cordis: join(harness, 'vendor/cordis/lib/index.js'),
  }
}

/** @returns {boolean} whether FlyBot compat should be active. */
export function isFlybotCompatEnabled(compat = 'auto', env = process.env) {
  const mode = String(env.JIUWEN_COMPAT || compat || 'auto').toLowerCase()
  if (mode === 'flybot') return true
  if (mode !== 'auto') return false
  return existsSync(flybotPaths(env).llm)
}

/** Extra module ids/paths to try when resolving LlmAdapter base. */
export function llmAdapterCandidates(env = process.env) {
  return [flybotPaths(env).llm]
}
