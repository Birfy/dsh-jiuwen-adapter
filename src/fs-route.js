/**
 * Route Jiuwen's side-effecting built-in FS/shell tools onto the dsh MCP passthrough
 * (sandbox, approval, background jobs) instead of Jiuwen's unsandboxed builtins.
 *
 * Side-effecting only: bash / write_file / edit_file are denied on the Jiuwen side.
 * Non-side-effect tools (read_file, todo_*, memory_*, tool_search, …) stay enabled.
 * The agent is pointed at mcp_<server>_bash|write|edit|read|glob|grep.
 */
export const JIUWEN_SIDE_EFFECT_TOOLS = Object.freeze(['bash', 'write_file', 'edit_file'])

/** dsh tool name → preferred Jiuwen-visible MCP name (server-prefixed). */
export function dshFsToolNames(serverName = 'dsh-tools') {
  const p = `mcp_${serverName}_`
  return {
    bash: `${p}bash`,
    write: `${p}write`,
    edit: `${p}edit`,
    read: `${p}read`,
    glob: `${p}glob`,
    grep: `${p}grep`,
  }
}

/** Short hint appended once per mapped session (system-inject style). */
export function fsRouteHint(serverName = 'dsh-tools') {
  const t = dshFsToolNames(serverName)
  return [
    '[Host FS routing]',
    `Jiuwen built-in bash / write_file / edit_file are denied. For shell and file IO use the dsh passthrough tools (sandboxed, approval-gated, background-job capable):`,
    `- shell: ${t.bash}`,
    `- write: ${t.write}`,
    `- edit: ${t.edit}`,
    `- read: ${t.read}`,
    `- glob/grep: ${t.glob}, ${t.grep}`,
    '[/Host FS routing]',
  ].join('\n')
}

/**
 * Deny Jiuwen side-effecting builtins so the model is forced onto the MCP tools.
 * Fail-soft: missing Gateway method / permission service = no throw.
 */
export async function denyJiuwenSideEffectTools(rpc, logger) {
  if (typeof rpc !== 'function') return { ok: false, reason: 'no-rpc' }
  const results = []
  for (const tool of JIUWEN_SIDE_EFFECT_TOOLS) {
    try {
      await rpc('permissions.tools.update', { tool, level: 'deny' }, { timeoutMs: 10_000 })
      results.push({ tool, level: 'deny' })
    } catch (e) {
      logger?.warn?.(`[dsh-jiuwen] mapJiuwenFsToDsh: deny ${tool} failed: ${e?.message || e}`)
      results.push({ tool, error: String(e?.message || e).slice(0, 120) })
    }
  }
  return { ok: results.every(r => !r.error), results }
}
