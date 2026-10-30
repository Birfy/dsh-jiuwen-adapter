/**
 * @dsh-jiuwen/adapter — Cordis plugin entry.
 * DSH = Cordis ABI/shell; JiuwenSwarm = agent brain (ARCHITECTURE.md).
 */
export { name, inject, Config, apply, JiuwenLlmAdapter, JIUWEN_EVENT, JIUWEN_TYPED_EVENTS } from './src/plugin.js'
export { SessionStore } from './src/session-store.js'
export { OpenAiTransport } from './src/openai-transport.js'
export { GatewayTransport } from './src/gateway-transport.js'
export { resolveConfig } from './src/config.js'
export { prepareBrainRequest, callKind } from './src/agent-brain.js'
export { resolveAuthMaterials, buildGatewayWsUrl } from './src/auth.js'
export { extractMediaFromOptions, attachMediaToChatParams } from './src/multimodal.js'
export * as e2a from './src/e2a-methods.js'
export { createFeatureCache, isUnknownMethod } from './src/features.js'
