/**
 * Enforce "Jiuwen owns the agent brain" on each GenerateOptions turn.
 * Strips DSH tool payloads so the local agent-loop cannot re-own tools/memory.
 */

/**
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
 * @param {import('./config.js').ResolvedConfig} config
 * @param {{ shouldForwardDshTools: () => boolean, jiuwenOwnsTools: () => boolean }} bridge
 * @param {{ warn?: Function }} [logger]
 */
export function prepareBrainRequest(options, config, bridge, logger) {
  const owns = bridge.jiuwenOwnsTools()
  if (!owns) {
    logger?.warn?.(
      '[dsh-jiuwen] allowDshAgentLoop=true: DSH will own tools/loop this turn (diagnostics only; not product path)',
    )
    return options
  }

  if (options.tools?.length || options.toolHistory) {
    logger?.info?.(
      `[dsh-jiuwen] stripping ${options.tools?.length ?? 0} DSH tool(s); JiuwenSwarm owns tools/memory/loop (mode=${config.mode})`,
    )
    return {
      ...options,
      tools: undefined,
      toolHistory: undefined,
    }
  }
  return options
}

/**
 * Purpose of one call for logging / session tagging.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
 */
export function callKind(options) {
  if (options.purpose === 'compaction') return 'compaction'
  if (options.purpose === 'session-title') return 'session-title'
  if (options.tools?.length) return 'agent-turn-with-dsh-tools'
  return 'agent-turn'
}
