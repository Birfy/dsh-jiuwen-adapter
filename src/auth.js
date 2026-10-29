/**
 * Auth helpers mirroring Jiuwen web proxy / webClient handshake.
 *
 * Token resolution order (same as gateway web_proxy_connect):
 *   1. ?access_token= / ?token= query
 *   2. Authorization: Bearer / X-Token header
 *   3. Cookie: access_token=…
 *   4. Config authToken / JIUWEN_AUTH_TOKEN / JIUWEN_ACCESS_TOKEN
 *
 * Browser WS cannot set headers; Node can — we send both query + headers.
 */

/**
 * @param {{
 *   authToken?: string,
 *   accessToken?: string,
 *   cookie?: string,
 *   authorization?: string,
 *   xToken?: string,
 *   userId?: string,
 * }} opts
 */
export function resolveAuthMaterials(opts = {}) {
  const token = firstNonEmpty(
    opts.accessToken,
    opts.authToken,
    bearerFrom(opts.authorization),
    opts.xToken,
    cookieNamed(opts.cookie, 'access_token'),
  )
  const cookie = opts.cookie
    || (token ? `access_token=${token}` : undefined)
  return {
    token,
    userId: opts.userId || 'dsh-adapter',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}`, 'X-Token': token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    cookie,
  }
}

/**
 * Append auth + user_id onto a Gateway WS URL.
 * @param {string} gatewayURL
 * @param {ReturnType<typeof resolveAuthMaterials>} auth
 */
export function buildGatewayWsUrl(gatewayURL, auth) {
  const u = new URL(gatewayURL)
  if (!u.pathname || u.pathname === '/') u.pathname = '/ws'
  if (auth.userId && !u.searchParams.has('user_id')) u.searchParams.set('user_id', auth.userId)
  if (auth.token) {
    if (!u.searchParams.has('access_token') && !u.searchParams.has('token')) {
      u.searchParams.set('access_token', auth.token)
    }
  }
  return u.toString()
}

function bearerFrom(authorization) {
  if (typeof authorization !== 'string') return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m?.[1]?.trim()
}

function cookieNamed(cookie, name) {
  if (typeof cookie !== 'string' || !cookie) return undefined
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=').trim() || undefined
  }
  return undefined
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}
