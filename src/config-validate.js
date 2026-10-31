/**
 * Load-time config validation that never throws: unknown keys (with the closest known key),
 * deprecated keys/values and obvious type mistakes become warnings. The host keeps loading.
 */
import { resolveConfig } from './config.js'

/** Every key resolveConfig reads from raw plugin config (kept in sync by test/config-validate.test.js). */
export const RAW_KEYS = Object.freeze(['accessToken', 'agentGroupName', 'agentTemplateName', 'allowDshAgentLoop', 'apiKey', 'apiKeyEnv', 'approvalTimeoutMs', 'authToken', 'authorization', 'baseURL', 'chatMode', 'commandName', 'compactionMode', 'cookie', 'defaultModel', 'discoveryNamespace', 'discoveryPrefix', 'displayName', 'documentPersist', 'emitUsage', 'eventDisplay', 'exposeJiuwenTools', 'finalGraceMs', 'forwardModelName', 'forwardReasoning', 'gatewayURL', 'historyMode', 'hostSync', 'ignoreMessagePatterns', 'injectSystem', 'interruptOnAbort', 'llmAdapterModule', 'mappingPath', 'mcpRpcTimeoutMs', 'mcpServerName', 'mcpStateDir', 'mode', 'modelDiscovery', 'models', 'noUiAnswer', 'planBridge', 'postCancelSettleMs', 'projectDir', 'provider', 'questionTimeoutMs', 'recoverOnDrop', 'recoverWindowMs', 'registerCommands', 'requestTimeoutMs', 'serviceName', 'sessionSync', 'showProcessingStatus', 'skills', 'supportsUserInteraction', 'surfaceGatewayToolEvents', 'swarmflowReply', 'swarmflowStopOnAbort', 'syncDelete', 'syncFork', 'syncGoal', 'syncGroup', 'syncMcp', 'syncMemory', 'syncModel', 'syncPause', 'syncPermissions', 'syncPlanMode', 'syncPlugins', 'syncSchedule', 'syncSkillInstall', 'syncSkills', 'syncTitle', 'syncWorkDir', 'terminalFinalGraceMs', 'titleMode', 'toolAllowlist', 'toolApproval', 'toolApprovalExempt', 'toolCallTimeoutMs', 'toolPassthrough', 'traceFile', 'trajectoryDetail', 'typedEvents', 'userId', 'workMode', 'xToken'])

/** Deprecated keys → advice. Values are still honoured. */
export const DEPRECATED_KEYS = Object.freeze({
  apiKey: 'inline secrets in plugin config end up in profile files; set the key in an environment variable and name it with `apiKeyEnv`',
})
/** Deprecated values: key → value → advice. */
export const DEPRECATED_VALUES = Object.freeze({
  compactionMode: { jiuwen: 'runs a full Jiuwen turn in a throwaway session; prefer the default compaction mode' },
})

const TYPES = { boolean: ['hostSync', 'syncSkills', 'syncMcp', 'syncModel', 'syncPlanMode', 'syncWorkDir', 'syncTitle', 'syncDelete', 'syncGoal', 'syncPause', 'syncPermissions', 'syncFork', 'syncGroup', 'syncSchedule', 'syncMemory', 'syncPlugins', 'syncSkillInstall', 'recoverOnDrop', 'allowDshAgentLoop', 'documentPersist', 'emitUsage', 'exposeJiuwenTools', 'forwardModelName', 'forwardReasoning', 'interruptOnAbort', 'modelDiscovery', 'noUiAnswer', 'planBridge', 'registerCommands', 'sessionSync', 'showProcessingStatus', 'supportsUserInteraction', 'surfaceGatewayToolEvents', 'swarmflowStopOnAbort', 'toolPassthrough', 'typedEvents'],
  number: ['recoverWindowMs', 'approvalTimeoutMs', 'finalGraceMs', 'mcpRpcTimeoutMs', 'postCancelSettleMs', 'questionTimeoutMs', 'requestTimeoutMs', 'terminalFinalGraceMs', 'toolCallTimeoutMs'],
  string: ['gatewayURL', 'baseURL', 'provider', 'commandName', 'serviceName', 'mappingPath', 'apiKeyEnv', 'defaultModel'],
  array: ['models', 'ignoreMessagePatterns', 'toolAllowlist'] }

let known
/** All accepted keys: what resolveConfig reads plus what it returns. */
export function knownKeys() {
  if (!known) {
    let resolved = {}
    try { resolved = resolveConfig({}, {}) } catch { /* fail soft */ }
    known = new Set([...RAW_KEYS, ...Object.keys(resolved)])
  }
  return known
}

function distance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase()
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
/** Closest known key, or undefined when nothing is plausibly meant. */
export function suggestKey(key, keys = knownKeys()) {
  let best, score = Infinity
  for (const k of keys) { const s = distance(key, k); if (s < score) { score = s; best = k } }
  return score <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined
}

/**
 * @param {unknown} raw plugin config
 * @returns {string[]} human-readable warnings (empty when clean); never throws
 */
export function validateConfig(raw) {
  const out = []
  try {
    if (raw === undefined || raw === null) return out
    if (typeof raw !== 'object' || Array.isArray(raw)) return [`config must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}; using defaults`]
    const keys = knownKeys()
    for (const [k, v] of Object.entries(raw)) {
      if (!keys.has(k)) { const s = suggestKey(k); out.push(`unknown config key "${k}"${s ? ` (did you mean "${s}"?)` : ''}; ignored`); continue }
      if (DEPRECATED_KEYS[k] && v !== undefined && v !== '') out.push(`config key "${k}" is deprecated: ${DEPRECATED_KEYS[k]}`)
      const dv = DEPRECATED_VALUES[k]?.[v]; if (dv) out.push(`config ${k}: "${v}" is deprecated: ${dv}`)
      if (v === undefined || v === null) continue
      const type = Object.entries(TYPES).find(([, ks]) => ks.includes(k))?.[0]
      const ok = !type || (type === 'array' ? Array.isArray(v) : type === 'number' ? (typeof v === 'number' || /^\d+$/.test(String(v))) : type === 'boolean' ? (typeof v === 'boolean' || /^(true|false|0|1)$/.test(String(v))) : typeof v === type)
      if (!ok) out.push(`config key "${k}" should be ${type === 'array' ? 'an array' : `a ${type}`}, got ${Array.isArray(v) ? 'array' : typeof v}`)
    }
  } catch (e) { out.push(`config validation skipped: ${e?.message || e}`) }
  return out
}
