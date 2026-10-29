import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuthMaterials, buildGatewayWsUrl } from '../src/auth.js'

test('resolveAuthMaterials prefers accessToken and builds cookie + bearer', () => {
  const a = resolveAuthMaterials({ accessToken: 'tok-1', userId: 'u1' })
  assert.equal(a.token, 'tok-1')
  assert.equal(a.headers.Authorization, 'Bearer tok-1')
  assert.equal(a.headers['X-Token'], 'tok-1')
  assert.match(a.cookie, /access_token=tok-1/)
})

test('resolveAuthMaterials reads Cookie access_token', () => {
  const a = resolveAuthMaterials({ cookie: 'foo=1; access_token=from-cookie; bar=2' })
  assert.equal(a.token, 'from-cookie')
})

test('resolveAuthMaterials reads Authorization Bearer', () => {
  const a = resolveAuthMaterials({ authorization: 'Bearer hdr-tok' })
  assert.equal(a.token, 'hdr-tok')
})

test('buildGatewayWsUrl sets user_id and access_token', () => {
  const auth = resolveAuthMaterials({ accessToken: 't', userId: 'alice' })
  const url = buildGatewayWsUrl('ws://127.0.0.1:19000/ws', auth)
  const u = new URL(url)
  assert.equal(u.searchParams.get('user_id'), 'alice')
  assert.equal(u.searchParams.get('access_token'), 't')
})
