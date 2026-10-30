/** Shared harness: spawn bin/mock-gateway.mjs on a random port and build a minimal Cordis-like host. */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../index.js'
import { GatewayTransport } from '../../src/gateway-transport.js'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export async function startMock() {
  const port = 25000 + Math.floor(Math.random() * 10000)
  const url = `ws://127.0.0.1:${port}/ws`
  const dir = mkdtempSync(join(tmpdir(), 'jw-ext-'))
  const gw = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], { env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(port), JIUWEN_GATEWAY_MOCK_SHAPE: '0.2.7' }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((res, rej) => { gw.stdout.on('data', d => /listening/.test(String(d)) && res()); gw.on('exit', c => rej(new Error(`exit ${c}`))) })
  return {
    url, dir,
    rpc: (m, p = {}) => new GatewayTransport({ gatewayURL: url }).rpc(m, p),
    stop() { gw.kill(); rmSync(dir, { recursive: true, force: true }) },
  }
}

export const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** Build a host ctx; `services` are returned by ctx.get(name). */
export function makeHost(mock, config = {}, { services = {}, commands = [], listeners = {}, emitted = [] } = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} }, ...(services.llm || {}) },
    logger: quiet,
    provide(n, v) { if (this[n] !== undefined && n !== 'llm') throw new Error(`service ${n} already provided`); this[n] = v },
    get(n) { return services[n] },
    on(name, fn) { (listeners[name] ||= []).push(fn); return () => {} },
    emit(name, ...args) { emitted.push([name, ...args]) },
    inject(_deps, cb) { cb({ commands: { register(d) { if (commands.some(c => c.name === d.name)) throw new Error(`duplicate command ${d.name}`); commands.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, `m-${Math.random()}.json`), finalGraceMs: 200, ...config })
  const def = commands.find(c => c.name === (config.commandName || 'jiuwen'))
  return {
    ctx, api: ctx[config.serviceName || 'jiuwenAdapter'], adapter: adapters.get(config.provider || 'jiuwen'), listeners, emitted, commands,
    cmd: async (raw, sid = 'ext-s') => (await def.handler({ agent: { id: sid }, rawInput: raw })),
    async run(o) { const cs = []; for await (const c of adapters.get(config.provider || 'jiuwen').stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 's', ...o })) cs.push(c); return cs },
  }
}
