import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSettingsStore, maskedSettings, SETTINGS_DIR } from './src/settings.js'
import {
  ChoerodonClient,
  keywordCondition,
  memberCondition,
  normalizeIssue,
  statusCondition,
} from './src/choerodon.js'
import { buildBrief, DISPATCH_KINDS, KIND_LABELS } from './src/brief.js'
import { IMAGE_PREFIX, imageProxyPath, sanitizeRichText } from './src/html.js'
import { attachmentsOf, detailUrl, htmlToText } from './src/text.js'

const API = '/api/choerodon'

/** Host half of the bundle: Choerodon client, credentials and the plugin's HTTP routes. */
export const inject = ['connection']

export function apply(ctx) {
  const store = createSettingsStore()
  const client = new ChoerodonClient(store.get)
  const imageToken = randomUUID()
  const imagePath = (url) => imageProxyPath(url, imageToken)

  const routes = createRoutes({ ctx, store, client, imagePath })
  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register(route), `choerodon-workbench: ${route.path}`)
  }

  // Screenshots are fetched by the browser as <img>/fetch with no Connection
  // credential, so they get their own plain route guarded by a per-boot token.
  const web = ctx.get('webServer')
  if (web && typeof web.register === 'function') {
    ctx.effect(
      () =>
        web.register({
          kind: 'prefix',
          path: IMAGE_PREFIX,
          resource: (request) => handleImageRequest(request, { store, client, imageToken }),
        }),
      'choerodon-workbench: image route',
    )
  }
  ctx.logger?.info?.(() => `choerodon-workbench: ${routes.length} routes + image route registered`)
}


function createRoutes({ store, client, imagePath }) {
  return [
    route(`${API}/state`, () => getState(store)),
    route(`${API}/settings`, (request) => postSettings({ store, client }, request)),
    route(`${API}/test`, (request) => postTest({ store, client }, request)),
    route(`${API}/projects`, () => getProjects(store)),
    route(`${API}/projects/all`, (request) => getProjectsAll({ client }, request)),
    route(`${API}/fields`, (request) => getFields({ client }, request)),
    route(`${API}/tasks`, (request) => getTasks({ store, client }, request)),
    route(`${API}/issue`, (request) => getIssue({ store, client, imagePath }, request)),
    route(`${API}/comments`, (request) => getComments({ client, imagePath }, request)),
    route(`${API}/status`, (request) => postStatus({ client }, request)),
    route(`${API}/comment`, (request) => postComment({ client }, request)),
    route(`${API}/dispatch`, (request) => postDispatch({ store, client }, request)),
  ]
}

function route(pathname, handler) {
  return {
    path: pathname,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request) => guard(() => handler(request)),
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function guard(run) {
  try {
    const value = await run()
    // Routes that own their response (the image proxy) pass a Response through.
    if (value instanceof Response) return value
    return jsonResponse(value)
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return jsonResponse({ ok: false, error: message })
  }
}

async function readBody(request) {
  if (request.method !== 'POST') return {}
  try {
    const text = await request.text()
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function paramsOf(request) {
  return new URL(request.url).searchParams
}

function boolParam(params, name, fallback = false) {
  const value = params.get(name)
  if (value === null) return fallback
  return value === '1' || value === 'true'
}

// ------------------------------------------------------------------- settings

async function getState(store) {
  const settings = await store.load()
  return {
    ok: true,
    settings: maskedSettings(settings),
    settingsFile: store.file,
    ready: Boolean(settings.username && settings.password),
    kinds: DISPATCH_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind] })),
  }
}

async function postSettings({ store, client }, request) {
  const body = await readBody(request)
  const patch = body && typeof body.settings === 'object' && body.settings ? body.settings : body
  const next = await store.save(patch || {})
  client.invalidate()
  return { ok: true, settings: maskedSettings(next) }
}

async function postTest({ store, client }, request) {
  const body = await readBody(request)
  const settings = await store.load()
  if (body && body.password) {
    await store.save({ ...(body.settings || {}), password: body.password })
    client.invalidate()
  }
  const current = await store.load()
  if (!current.password) return { ok: false, error: '请先填写密码' }
  client.invalidate()
  const self = await client.self()
  const stars = await client.starProjects()
  const watched = []
  for (const project of current.projects) {
    try {
      const total = await client.baselineTotal(project.projectId)
      watched.push({ projectId: project.projectId, name: project.name, total })
    } catch (error) {
      watched.push({ projectId: project.projectId, name: project.name, error: error.message })
    }
  }
  return { ok: true, user: self, starCount: stars.length, projects: watched }
}

// ------------------------------------------------------------------- projects

async function getProjects(store) {
  const settings = await store.load()
  return {
    ok: true,
    projects: settings.projects,
    defaultProjectId: settings.defaultProjectId,
    pageSize: settings.pageSize,
    dispatchMode: settings.dispatchMode,
    sessionRoot: settings.sessionRoot,
  }
}

async function getProjectsAll({ client }, request) {
  const query = String(paramsOf(request).get('q') || '').trim().toLowerCase()
  const all = await client.allProjects()
  const matched = query
    ? all.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.projectId.includes(query),
      )
    : all
  return {
    ok: true,
    total: all.length,
    items: matched.slice(0, 100).map(({ projectId, name, code, category, starFlag }) => ({
      projectId,
      name,
      code,
      category,
      starFlag,
    })),
  }
}

async function getFields({ client }, request) {
  const projectId = String(paramsOf(request).get('projectId') || '')
  if (!projectId) return { ok: false, error: '缺少 projectId' }
  const fields = await client.memberFields(projectId)
  return {
    ok: true,
    fields: fields.map((field) => ({
      code: field.code,
      name: field.name,
      fieldType: field.fieldType,
      predefined: Boolean(field.system),
    })),
  }
}

// --------------------------------------------------------------------- issues

async function getTasks({ store, client }, request) {
  const settings = await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || settings.defaultProjectId || '')
  if (!projectId) return { ok: false, error: '缺少 projectId' }
  const page = Math.max(0, Number(params.get('page') || 0) || 0)
  const size = Math.min(100, Math.max(1, Number(params.get('size') || settings.pageSize || 20) || 20))
  const keyword = String(params.get('keyword') || '').trim()
  const selfOnly = boolParam(params, 'selfOnly', true)
  const unfinished = boolParam(params, 'unfinished', true)
  const project = settings.projects.find((item) => item.projectId === projectId) || {
    projectId,
    code: '',
    name: '',
    filter: null,
  }

  const conditions = []
  let filterWarning = false
  let filterLabel = ''

  if (selfOnly) {
    const filter = project.filter
    if (filter && filter.code) {
      filterLabel = filter.name || filter.code
      try {
        const self = await client.self()
        if (filter.predefined || filter.code === 'assignee') {
          conditions.push(memberCondition({ ...filter, predefined: true }, self.id))
        } else {
          const fields = await client.fieldDefs(projectId)
          const def = fields.find((field) => field.code === filter.code)
          if (def && def.id) {
            conditions.push(memberCondition({ ...filter, predefined: false, fieldId: def.id }, self.id))
          } else {
            filterWarning = true
          }
        }
      } catch (error) {
        filterWarning = true
      }
    }
  }

  if (unfinished) {
    try {
      const statusIds = await client.unfinishedStatusIds(projectId, settings.unfinishedTypes)
      if (statusIds.length > 0) conditions.push(statusCondition(statusIds))
    } catch {
      // Ignore: an unsupported status filter should not break the list.
    }
  }

  const keywordEntry = keywordCondition(keyword)
  if (keywordEntry) conditions.push(keywordEntry)

  const body = { treeFlag: true, withSubIssues: false }
  if (conditions.length > 0) body.conditions = conditions

  const data = await client.workList(projectId, body, page, size)
  const rows = Array.isArray(data?.content) ? data.content : []
  const total = Number(data?.totalElements ?? rows.length)

  if (selfOnly && !unfinished && !keyword && filterLabel && !filterWarning) {
    try {
      const baseline = await client.baselineTotal(projectId)
      if (Number.isFinite(baseline) && baseline > 0 && total >= baseline) filterWarning = true
    } catch {
      // Best effort only.
    }
  }

  return {
    ok: true,
    items: rows.map((row) => normalizeIssue(row, project)),
    page,
    size,
    total,
    totalPages: Math.max(1, Number(data?.totalPages ?? Math.ceil(total / size) ?? 1)),
    filter: { selfOnly, unfinished, label: filterLabel, warning: filterWarning },
  }
}

async function getIssue({ store, client, imagePath }, request) {
  const settings = await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  const project = settings.projects.find((item) => item.projectId === projectId) || {
    projectId,
    code: '',
    name: '',
    category: '',
  }
  const detail = await client.issueDetail(projectId, issueId)
  let transforms = []
  let transformsError = ''
  try {
    transforms = await client.transforms(projectId, {
      statusId: detail?.statusVO?.id,
      issueId,
      issueTypeId: detail?.issueTypeId,
    })
  } catch (error) {
    transformsError = error.message
  }
  const numericId = await client.decryptIssueId(projectId, issueId)
  const consoleUrl = detailUrl(settings.detailUrlTemplate, {
    issueId: numericId,
    issueNum: detail?.issueNum ?? '',
    projectId,
    projectName: project.name || detail?.projectName || '',
    category: project.category || '',
    orgId: settings.organizationId,
  })
  return {
    ok: true,
    issue: {
      issueId: String(detail?.issueId ?? issueId),
      issueNum: String(detail?.issueNum ?? ''),
      summary: String(detail?.summary ?? ''),
      descriptionHtml: sanitizeRichText(String(detail?.description ?? ''), imagePath),
      descriptionText: htmlToText(detail?.description, 6000),
      statusName: String(detail?.statusVO?.name ?? ''),
      statusType: String(detail?.statusVO?.type ?? ''),
      statusId: String(detail?.statusVO?.id ?? ''),
      typeName: String(detail?.issueTypeVO?.name ?? detail?.typeCode ?? ''),
      typeCode: String(detail?.typeCode ?? ''),
      priority: String(detail?.priorityVO?.name ?? ''),
      assignee: String(detail?.assigneeRealName ?? detail?.assigneeName ?? ''),
      reporter: String(detail?.reporterRealName ?? detail?.reporterName ?? ''),
      creationDate: String(detail?.creationDate ?? ''),
      lastUpdateDate: String(detail?.lastUpdateDate ?? ''),
      objectVersionNumber: Number(detail?.objectVersionNumber ?? 0),
      issueTypeId: String(detail?.issueTypeId ?? ''),
      attachments: attachmentsOf(detail),
      projectId,
      projectName: project.name || String(detail?.projectName ?? ''),
      projectCode: project.code || '',
    },
    transforms,
    transformsError,
    consoleUrl,
  }
}

async function getComments({ client, imagePath }, request) {
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  const page = Math.max(0, Number(params.get('page') || 0) || 0)
  const size = Math.min(50, Math.max(1, Number(params.get('size') || 20) || 20))
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  const list = await client.comments(projectId, issueId, page, size)
  return {
    ok: true,
    ...list,
    items: list.items.map((item) => ({
      ...item,
      textHtml: sanitizeRichText(item.text, imagePath),
    })),
  }
}

// ---------------------------------------------------------------- rich media

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const IMAGE_TTL_MS = 30 * 60 * 1000
const IMAGE_MAX_ENTRIES = 60
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
const imageCache = new Map()

function imageResponse(bytes, type) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'private, max-age=900' },
  })
}

async function tryFetch(url, headers) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) return null
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      type: response.headers.get('content-type') || '',
    }
  } catch {
    return null
  }
}

/**
 * Fetch one screenshot. Public buckets reject an Authorization header, so the
 * token only rides along on an authenticated retry against the gateway, and a
 * private file whose embedded token expired is re-signed through hfle.
 */
async function fetchImageBytes(target, ctx) {
  const plain = await tryFetch(target.toString(), {})
  if (plain) return plain

  let gatewayHost = ''
  try {
    gatewayHost = new URL(ctx.base).hostname.toLowerCase()
  } catch {
    gatewayHost = ''
  }
  if (gatewayHost && target.hostname.toLowerCase() === gatewayHost) {
    try {
      const token = await ctx.client.token()
      const authed = await tryFetch(target.toString(), {
        authorization: `bearer ${token}`,
        'h-tenant-id': ctx.tenantId || '1',
        'h-menu-id': '0',
      })
      if (authed) return authed
    } catch {
      // Fall through to re-signing.
    }
  }

  try {
    const token = await ctx.client.token()
    const signUrl = `${ctx.base}/hfle/v1/files/redirect-url?bucketName=private&access_token=${token}&url=${encodeURIComponent(target.toString())}`
    const signed = await fetch(signUrl, {
      headers: { 'user-agent': UA, 'h-tenant-id': ctx.tenantId || '1', 'h-menu-id': '0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    })
    const location = signed.headers.get('location')
    if (location) return await tryFetch(location, {})
  } catch {
    // The placeholder below is the final answer.
  }
  return null
}

function sniffImageType(bytes, declared) {
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp'
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  }
  return declared && /^image\//i.test(declared) ? declared.split(';')[0] : ''
}

/** Render a small inline SVG so an expired screenshot still leaves a readable card. */
function placeholderImage(reason) {
  const label = reason === 'expired' ? '图片链接已失效，请在控制台查看' : '图片加载失败，请在控制台查看'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="76"><rect x="1" y="1" width="358" height="74" rx="8" fill="none" stroke="#9aa0a6" stroke-dasharray="5 4"/><text x="180" y="44" font-family="system-ui,sans-serif" font-size="12" fill="#9aa0a6" text-anchor="middle">${label}</text></svg>`
  return new Response(Buffer.from(svg), {
    status: 200,
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Refuse loopback/private targets so a ticket cannot make the Host probe itself. */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.endsWith('.internal') || host.endsWith('.lan')) return true
  if (host.startsWith('[') || host.includes(':')) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/**
 * Any public image host is allowed: ticket screenshots come from MinIO, the
 * file services and third-party CDNs that teams paste screenshots from.
 */
function imageHostAllowed(target) {
  if (!/^https?:$/.test(target.protocol)) return false
  return !isPrivateHost(target.hostname)
}

/** Token-guarded plain HTTP entry for browser image requests. */
async function handleImageRequest(request, { store, client, imageToken }) {
  const url = new URL(request.url)
  if (url.pathname !== `${IMAGE_PREFIX}/image`) return new Response('not found', { status: 404 })
  const token = url.searchParams.get('t') || ''
  if (!token || token !== imageToken) return new Response('forbidden', { status: 403 })
  const raw = String(url.searchParams.get('url') || '').trim()
  return serveImage({ store, client, raw })
}

/** Serve one remote screenshot with re-signing, type sniffing, caching and a placeholder fallback. */
async function serveImage({ store, client, raw }) {
  if (!raw) return new Response('missing url', { status: 400 })
  let target
  try {
    target = new URL(raw)
  } catch {
    return new Response('bad url', { status: 400 })
  }
  if (!/^https?:$/.test(target.protocol)) return new Response('bad scheme', { status: 400 })

  const now = Date.now()
  const cached = imageCache.get(raw)
  if (cached && now - cached.at < IMAGE_TTL_MS) return imageResponse(cached.bytes, cached.type)

  const settings = await store.load()
  if (!imageHostAllowed(target)) {
    logImage({ target: target.href, outcome: 'host-not-allowed' })
    return new Response('host not allowed', { status: 403 })
  }

  const fetched = await fetchImageBytes(target, {
    client,
    base: String(settings.baseUrl || '').replace(/\/+$/, ''),
    tenantId: settings.tenantId,
  })
  if (!fetched) {
    logImage({ target: target.href, outcome: 'fetch-failed' })
    return placeholderImage('expired')
  }
  if (fetched.bytes.length > IMAGE_MAX_BYTES) {
    logImage({ target: target.href, outcome: 'too-large', bytes: fetched.bytes.length })
    return placeholderImage('large')
  }
  const type = sniffImageType(fetched.bytes, fetched.type)
  if (!type) {
    logImage({ target: target.href, outcome: 'not-image', type: fetched.type, bytes: fetched.bytes.length })
    return placeholderImage('broken')
  }
  logImage({ target: target.href, outcome: 'ok', type, bytes: fetched.bytes.length })
  imageCache.set(raw, { at: now, bytes: fetched.bytes, type })
  if (imageCache.size > IMAGE_MAX_ENTRIES) {
    const oldest = [...imageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) imageCache.delete(oldest[0])
  }
  return imageResponse(fetched.bytes, type)
}

const imageLog = []
function logImage(entry) {
  const line = { at: new Date().toISOString(), ...entry }
  imageLog.push(line)
  if (imageLog.length > 200) imageLog.shift()
  try {
    const file = path.join(SETTINGS_DIR, 'image.log')
    fs.appendFile(file, JSON.stringify(line) + '\n').catch(() => {})
  } catch {
    // Diagnostics are best effort.
  }
}

// ---------------------------------------------------------------- write paths

async function postStatus({ client }, request) {
  const body = await readBody(request)
  const { projectId, issueId, transformId, objectVersionNumber } = body || {}
  if (!projectId || !issueId || !transformId) return { ok: false, error: '缺少参数' }
  const updated = await client.updateStatus(projectId, { transformId, issueId, objectVersionNumber })
  return {
    ok: true,
    statusName: String(updated?.statusVO?.name ?? ''),
    statusType: String(updated?.statusVO?.type ?? ''),
    objectVersionNumber: Number(updated?.objectVersionNumber ?? 0),
  }
}

async function postComment({ client }, request) {
  const body = await readBody(request)
  const action = String(body?.action || 'add')
  const projectId = String(body?.projectId || '')
  if (!projectId) return { ok: false, error: '缺少 projectId' }
  if (action === 'add') {
    const text = String(body?.text || '').trim()
    if (!text) return { ok: false, error: '评论内容不能为空' }
    await client.addComment(projectId, String(body?.issueId || ''), text)
  } else if (action === 'update') {
    const text = String(body?.text || '').trim()
    if (!text) return { ok: false, error: '评论内容不能为空' }
    await client.updateComment(projectId, {
      commentId: String(body?.commentId || ''),
      objectVersionNumber: Number(body?.objectVersionNumber || 0),
      text,
    })
  } else if (action === 'delete') {
    await client.deleteComment(projectId, String(body?.commentId || ''))
  } else {
    return { ok: false, error: `未知操作：${action}` }
  }
  return { ok: true }
}

async function postDispatch({ store, client }, request) {
  const body = await readBody(request)
  const settings = await store.load()
  const projectId = String(body?.projectId || '')
  const issueId = String(body?.issueId || '')
  const kind = String(body?.kind || 'bug')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  if (!DISPATCH_KINDS.includes(kind)) return { ok: false, error: `未知处理类型：${kind}` }

  const project = settings.projects.find((item) => item.projectId === projectId) || {
    projectId,
    code: '',
    name: '',
    category: '',
  }
  const detail = await client.issueDetail(projectId, issueId)
  const numericId = await client.decryptIssueId(projectId, issueId)
  const consoleUrl = detailUrl(settings.detailUrlTemplate, {
    issueId: numericId,
    issueNum: detail?.issueNum ?? '',
    projectId,
    projectName: project.name || detail?.projectName || '',
    category: project.category || '',
    orgId: settings.organizationId,
  })
  const issue = {
    issueId,
    issueNum: String(detail?.issueNum ?? ''),
    summary: String(detail?.summary ?? ''),
    descriptionHtml: String(detail?.description ?? ''),
    statusName: String(detail?.statusVO?.name ?? ''),
    typeName: String(detail?.issueTypeVO?.name ?? detail?.typeCode ?? ''),
    priority: String(detail?.priorityVO?.name ?? ''),
    assignee: String(detail?.assigneeRealName ?? detail?.assigneeName ?? ''),
    reporter: String(detail?.reporterRealName ?? detail?.reporterName ?? ''),
    lastUpdateDate: String(detail?.lastUpdateDate ?? ''),
    attachments: attachmentsOf(detail),
    projectId,
    projectName: project.name || String(detail?.projectName ?? ''),
    projectCode: project.code || '',
  }
  const { title, prompt } = buildBrief({ issue, kind, orgId: settings.organizationId, consoleUrl })

  const safeCode = String(project.code || projectId).replace(/[^A-Za-z0-9._-]/g, '_')
  const sessionRoot = String(settings.sessionRoot || '').trim() || path.join(os.homedir(), 'choerodon-sessions')
  const directory = path.join(sessionRoot, safeCode)
  await fs.mkdir(directory, { recursive: true })

  return { ok: true, kind, title, prompt, dir: directory, mode: settings.dispatchMode }
}
