import { lookup } from 'node:dns/promises'
import { promises as fs } from 'node:fs'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import path from 'node:path'

import { IMAGE_PREFIX } from './html.js'
import { SETTINGS_DIR } from './settings.js'

const CDN_HOST = 'wdcdn.qpic.cn'
const MAX_BYTES = 20 * 1024 * 1024
const CACHE_MAX_BYTES = 48 * 1024 * 1024
const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_CONCURRENT = 4
const MAX_QUEUED = 32
const REQUEST_TIMEOUT_MS = 20_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const RESPONSE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
const LABELS = {
  blocked: '图片来源不受信任，请在控制台查看',
  expired: '图片链接已失效，请在控制台查看',
  large: '图片超过 20 MB，请在控制台查看',
  busy: '图片暂时无法加载，请稍后刷新',
  timeout: '图片加载超时，请稍后刷新',
  unsupported: '图片格式无法预览，请在控制台查看',
  failed: '图片加载失败，请在控制台查看',
}

const blockedAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blockedAddresses.addSubnet(address, prefix)
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6')
}
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')

function publicAddress(address) {
  const family = isIP(address)
  if (family === 4) return !blockedAddresses.check(address)
  return family === 6 && globalIpv6.check(address, 'ipv6') && !blockedAddresses.check(address, 'ipv6')
}

class ImageFailure extends Error {}

function imageUrl(raw, base) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 16 * 1024) return null
  try {
    const url = new URL(raw, base)
    if (url.protocol !== 'https:' || url.username || url.password ||
      url.hostname.length > 253 || url.hostname.startsWith('[') || isIP(url.hostname)) return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function imagePolicy(settings) {
  const gateway = imageUrl(settings.baseUrl)
  const gatewayFilePath = gateway ? `${gateway.pathname.replace(/\/+$/, '')}/hfle/` : ''
  const fileOrigins = new Set()
  const configured = Array.isArray(settings.imageHosts) ? settings.imageHosts : []
  for (const entry of configured) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const candidate = entry.trim()
    const url = imageUrl(candidate.includes('://') ? candidate : `https://${candidate}`)
    if (url && url.pathname === '/' && !url.search) fileOrigins.add(url.origin)
  }
  return {
    gateway,
    gatewayFilePath,
    tenantId: settings.tenantId || '1',
    fileOrigins,
    allowedOrigins: new Set([...fileOrigins, `https://${CDN_HOST}`, gateway?.origin].filter(Boolean)),
  }
}

function follow(location, from, policy, token) {
  if (!location) return null
  const target = imageUrl(location, from)
  if (!target || !policy.allowedOrigins.has(target.origin)) throw new ImageFailure('blocked')
  if (token && target.origin !== policy.gateway.origin && [...target.searchParams.values()].includes(token)) {
    throw new ImageFailure('blocked')
  }
  return target
}

function isGatewayFile(target, policy) {
  if (target.origin !== policy.gateway?.origin || !target.pathname.startsWith(policy.gatewayFilePath)) return false
  try {
    const segments = decodeURIComponent(target.pathname).split(/[\\/]/)
    return !segments.some((segment) => segment === '..' || segment === '.')
  } catch {
    return false
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function open(url, headers, { signal, lookupHost, requestHttps }) {
  signal.throwIfAborted()
  const records = await abortable(lookupHost(url.hostname, { all: true }), signal)
  const verified = records.find(({ address }) => publicAddress(address))
  if (!verified) throw new ImageFailure('blocked')
  const { address } = verified
  const family = isIP(address)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // A fresh connection uses the verified address while TLS verifies the original hostname.
    const outbound = requestHttps(url, {
      agent: false,
      family,
      rejectUnauthorized: true,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      },
      headers: { accept: 'image/*, */*;q=0.1', 'user-agent': 'Mozilla/5.0', ...headers },
      signal,
    }, resolve)
    outbound.once('error', reject)
    outbound.end()
  })
}

async function readImage(response) {
  if (Number(response.headers['content-length']) > MAX_BYTES) {
    response.destroy()
    throw new ImageFailure('large')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > MAX_BYTES) throw new ImageFailure('large')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, size)
  const hex = bytes.subarray(0, 8).toString('hex')
  if (hex === '89504e470d0a1a0a') return { bytes, type: 'image/png' }
  if (hex.startsWith('ffd8ff')) return { bytes, type: 'image/jpeg' }
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return { bytes, type: 'image/gif' }
  if (hex.startsWith('424d')) return { bytes, type: 'image/bmp' }
  if (hex.startsWith('00000100')) return { bytes, type: 'image/x-icon' }
  if (hex.startsWith('52494646') && bytes.toString('ascii', 8, 12) === 'WEBP') return { bytes, type: 'image/webp' }
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(bytes.length, bytes.readUInt32BE(0))
    for (let pos = 8; pos + 4 <= end; pos += pos === 8 ? 8 : 4) {
      if (['avif', 'avis'].includes(bytes.toString('ascii', pos, pos + 4))) return { bytes, type: 'image/avif' }
    }
  }
  return { status: 'unsupported' }
}

async function downloadImage(target, context, { token, authenticateGateway = false } = {}) {
  const { policy } = context
  let current = target
  for (let hop = 0; hop <= 4; hop += 1) {
    const authenticate = authenticateGateway && isGatewayFile(current, policy)
    const response = await open(current, authenticate ? {
      authorization: `bearer ${token}`, 'h-tenant-id': policy.tenantId, 'h-menu-id': '0',
    } : {}, context)
    const status = response.statusCode
    if (status >= 200 && status < 300) return readImage(response)
    const location = response.headers.location
    response.destroy()
    if (!REDIRECTS.has(status) || !location) return { status }
    current = follow(location, current, policy, token)
  }
  throw new ImageFailure('failed')
}

async function resolveImage(target, context) {
  const { client, policy, signal } = context
  const direct = await downloadImage(target, context)
  if (direct.bytes) return direct
  const gatewayFile = isGatewayFile(target, policy)
  if (policy.gateway && (gatewayFile || policy.fileOrigins.has(target.origin))) {
    const token = await abortable(client.token(), signal)
    if (gatewayFile) {
      const authenticated = await downloadImage(target, context, { token, authenticateGateway: true })
      if (authenticated.bytes) return authenticated
    }
    const signUrl = new URL(policy.gateway.origin)
    signUrl.pathname = `${policy.gatewayFilePath}v1/files/redirect-url`
    signUrl.search = new URLSearchParams({ bucketName: 'private', access_token: token, url: target.href })
    const signed = await open(signUrl, { 'h-tenant-id': policy.tenantId, 'h-menu-id': '0' }, context)
    const location = signed.headers.location
    const redirected = REDIRECTS.has(signed.statusCode)
    signed.destroy()
    if (redirected && location) {
      const result = await downloadImage(follow(location, signUrl, policy, token), context, { token })
      if (result.bytes) return result
      if (result.status === 'unsupported') throw new ImageFailure('unsupported')
    }
    throw new ImageFailure('expired')
  }
  if ([401, 403, 404, 410].includes(direct.status)) throw new ImageFailure('expired')
  throw new ImageFailure(direct.status === 'unsupported' ? 'unsupported' : 'failed')
}

function imageResponse({ bytes, type }, extraHeaders) {
  return new Response(bytes, { headers: { ...RESPONSE_HEADERS, 'content-type': type, ...extraHeaders } })
}

function placeholder(reason) {
  const label = LABELS[reason] || LABELS.failed
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="76"><rect x="1" y="1" width="358" height="74" rx="8" fill="none" stroke="#9aa0a6" stroke-dasharray="5 4"/><text x="180" y="44" font-family="system-ui,sans-serif" font-size="12" fill="#9aa0a6" text-anchor="middle">${label}</text></svg>`
  return imageResponse({ bytes: svg, type: 'image/svg+xml; charset=utf-8' }, { 'x-choerodon-image-error': reason })
}

export function createImageProxy({ store, client, imageToken, lookupHost = lookup, requestHttps = request }) {
  const cache = new Map()
  const pending = new Map()
  const waiting = []
  let cacheBytes = 0
  let active = 0
  let epoch = new AbortController()
  let logTail = Promise.resolve()
  let queuedLogs = 0

  function log(host, outcome, bytes) {
    if (queuedLogs >= MAX_QUEUED) return
    const line = JSON.stringify({ at: new Date().toISOString(), host, outcome, bytes }) + '\n'
    const file = path.join(SETTINGS_DIR, 'image.log')
    queuedLogs += 1
    logTail = logTail.then(async () => {
      await fs.mkdir(SETTINGS_DIR, { recursive: true, mode: 0o700 })
      const current = await fs.stat(file).catch(() => null)
      if (current) await fs.chmod(file, 0o600)
      if (current && current.size + Buffer.byteLength(line) > 128 * 1024) await fs.rename(file, `${file}.1`)
      await fs.appendFile(file, line, { mode: 0o600 })
    }).catch(() => {}).finally(() => { queuedLogs -= 1 })
  }

  function remember(key, result) {
    cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS })
    cacheBytes += result.bytes.length
    while (cache.size > 60 || cacheBytes > CACHE_MAX_BYTES) {
      const oldest = cache.keys().next().value
      cacheBytes -= cache.get(oldest).result.bytes.length
      cache.delete(oldest)
    }
  }

  function schedule(run) {
    return new Promise((resolve, reject) => {
      if (waiting.length >= MAX_QUEUED) return reject(new ImageFailure('busy'))
      const start = async () => {
        active += 1
        try {
          resolve(await run())
        } catch (error) {
          reject(error)
        } finally {
          active -= 1
          waiting.shift()?.()
        }
      }
      if (active < MAX_CONCURRENT) start()
      else waiting.push(start)
    })
  }

  async function handle(incoming) {
    const url = new URL(incoming.url)
    if (url.pathname !== `${IMAGE_PREFIX}/image`) return new Response('not found', { status: 404 })
    if (incoming.method !== 'GET') return new Response('method not allowed', { status: 405 })
    if (!url.searchParams.get('t') || url.searchParams.get('t') !== imageToken) {
      return new Response('forbidden', { status: 403 })
    }
    const target = imageUrl(url.searchParams.get('url'))
    if (!target) return placeholder('blocked')
    const currentEpoch = epoch.signal
    try {
      const policy = imagePolicy(await store.load())
      currentEpoch.throwIfAborted()
      if (!policy.allowedOrigins.has(target.origin)) throw new ImageFailure('blocked')
      const key = target.href
      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        if (hit.expires > Date.now()) {
          cache.set(key, hit)
          return imageResponse(hit.result)
        }
        cacheBytes -= hit.result.bytes.length
      }
      if (!pending.has(key)) {
        const requestController = new AbortController()
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const abortOnClear = () => requestController.abort(currentEpoch.reason)
        const abortOnTimeout = () => requestController.abort(timeout.reason)
        currentEpoch.addEventListener('abort', abortOnClear, { once: true })
        timeout.addEventListener('abort', abortOnTimeout, { once: true })
        const { signal } = requestController
        const context = { policy, client, signal, lookupHost, requestHttps }
        const operation = abortable(schedule(() => resolveImage(target, context)), signal).then((result) => {
          signal.throwIfAborted()
          remember(key, result)
          log(target.hostname, 'ok', result.bytes.length)
          return result
        }).finally(() => {
          currentEpoch.removeEventListener('abort', abortOnClear)
          timeout.removeEventListener('abort', abortOnTimeout)
          if (pending.get(key) === operation) pending.delete(key)
        })
        pending.set(key, operation)
      }
      const result = await pending.get(key)
      currentEpoch.throwIfAborted()
      return imageResponse(result)
    } catch (error) {
      const reason = error instanceof ImageFailure ? error.message : error?.name === 'TimeoutError' ? 'timeout' : 'failed'
      log(target.hostname, reason)
      return placeholder(reason)
    }
  }

  function clear() {
    epoch.abort()
    epoch = new AbortController()
    cache.clear()
    pending.clear()
    cacheBytes = 0
  }

  return { handle, clear }
}
