import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSettingsStore, maskedSettings, normalizePageSize } from './src/settings.js'
import {
  ChoerodonClient,
  dateCondition,
  keywordCondition,
  memberCondition,
  normalizeIssue,
  statusCondition,
} from './src/choerodon.js'
import { buildBrief, DISPATCH_KINDS, KIND_LABELS } from './src/brief.js'
import { IMAGE_PREFIX, imageProxyPath, sanitizeRichText } from './src/html.js'
import { createImageProxy } from './src/images.js'
import { attachmentsOf, detailUrl, htmlToText } from './src/text.js'
import { buildHandoffTemplate, HANDOFF_ROLES, normalizeHandoffText, parseHandoffComment } from './src/handoff.js'

const API = '/api/choerodon'

/** Host half of the bundle: Choerodon client, credentials and the plugin's HTTP routes. */
export const inject = ['connection']

export function apply(ctx) {
  const store = createSettingsStore()
  const client = new ChoerodonClient(store.get)
  const imageToken = randomUUID()
  const imagePath = (url) => imageProxyPath(url, imageToken)
  const images = createImageProxy({ store, client, imageToken })

  const routes = createRoutes({ store, client, imagePath, images })
  for (const route of routes) {
    const { fetch, ...definition } = route
    ctx.effect(() => ctx.connection.fetch.register({
      ...definition,
      fetch: (request) => guard(async () => {
        await store.load()
        return fetch(request)
      }),
    }), `choerodon-workbench: ${route.path}`)
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
          resource: (request) => images.handle(request),
        }),
      'choerodon-workbench: image route',
    )
  }
  ctx.logger?.info?.(() => `choerodon-workbench: ${routes.length} routes + image route registered`)
}


function createRoutes({ store, client, imagePath, images }) {
  const handoffs = createHandoffPublisher(client)
  return [
    route(`${API}/state`, () => getState(store)),
    route(`${API}/settings`, (request) => postSettings({ store, client, images }, request), 'POST'),
    route(`${API}/test`, (request) => postTest(store, request), 'POST'),
    route(`${API}/projects`, () => getProjects(store)),
    route(`${API}/projects/all`, (request) => getProjectsAll({ client }, request)),
    route(`${API}/fields`, (request) => getFields({ client }, request)),
    route(`${API}/tasks`, (request) => getTasks({ store, client }, request)),
    route(`${API}/lookup`, (request) => getIssueLookup({ store, client }, request)),
    route(`${API}/issue`, (request) => getIssue({ store, client, imagePath }, request)),
    route(`${API}/issue/link`, (request) => getIssueLink({ store, client }, request)),
    route(`${API}/transforms`, (request) => getIssueTransforms({ store, client }, request)),
    route(`${API}/comments`, (request) => getComments({ client, imagePath }, request)),
    route(`${API}/handoffs`, (request) => getHandoffs({ client }, request)),
    route(`${API}/handoff/template`, (request) => postHandoffTemplate({ store, client }, request), 'POST'),
    route(`${API}/status`, (request) => postStatus({ client }, request), 'POST'),
    route(`${API}/comment`, (request) => postComment({ client }, request), 'POST'),
    route(`${API}/handoff`, handoffs.publish, 'POST'),
    route(`${API}/handoff/verify`, handoffs.verify, 'POST'),
    route(`${API}/dispatch`, (request) => postDispatch({ store, client }, request), 'POST'),
    route(`${API}/dispatch/confirm`, (request) => postDispatchConfirm({ store, client }, request), 'POST'),
  ]
}

function route(pathname, handler, method = 'GET') {
  return {
    path: pathname,
    methods: [method],
    requestBody: 'buffered',
    fetch: handler,
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
  try {
    const text = await request.text()
    const data = text ? JSON.parse(text) : {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data
  } catch {
    throw new Error('请求内容必须为 JSON 对象')
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

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localToday() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** Subtract calendar months with month-end clamping (May 31 - 3m => Feb 28). */
function monthsBackDate(months) {
  const now = new Date()
  const wantedMonth = ((now.getMonth() - months) % 12 + 12) % 12
  const result = new Date(now.getFullYear(), now.getMonth() - months, now.getDate())
  if (result.getMonth() !== wantedMonth) result.setDate(0)
  return `${result.getFullYear()}-${pad2(result.getMonth() + 1)}-${pad2(result.getDate())}`
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
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

async function postSettings({ store, client, images }, request) {
  const body = await readBody(request)
  const patch = body && typeof body.settings === 'object' && body.settings ? body.settings : body
  const previous = await store.load()
  const next = await store.save(patch || {})
  if (['baseUrl', 'username', 'password', 'organizationId', 'tenantId'].some((key) => previous[key] !== next[key])) {
    client.resetAuthentication()
  } else {
    client.invalidate()
  }
  images.clear()
  return { ok: true, settings: maskedSettings(next) }
}

async function postTest(store, request) {
  const body = await readBody(request)
  const saved = await store.load()
  const current = { ...saved }
  if (body.settings && typeof body.settings === 'object') {
    for (const key of ['baseUrl', 'username', 'organizationId', 'tenantId', 'projects']) {
      if (Object.hasOwn(body.settings, key)) current[key] = body.settings[key]
    }
  }
  if (typeof body.password === 'string' && body.password) {
    current.password = body.password
  } else if (current.baseUrl !== saved.baseUrl || current.username !== saved.username) {
    return { ok: false, error: '测试其他网关或账号时，请同时提供对应密码。' }
  }
  if (!current.password) return { ok: false, error: '请先填写密码' }
  if (!Array.isArray(current.projects)) return { ok: false, error: '关注项目格式无效' }
  const testClient = new ChoerodonClient(() => current)
  const self = await testClient.self()
  const stars = await testClient.starProjects()
  const watched = await Promise.all(current.projects.map(async (project) => {
    try {
      const total = await testClient.baselineTotal(project.projectId)
      return { projectId: project.projectId, name: project.name, total }
    } catch (error) {
      return { projectId: project.projectId, name: project.name, error: error.message }
    }
  }))
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

const ISSUE_NUMBER = /^([A-Za-z][A-Za-z0-9_-]*)-\d+$/
const LIST_SORTS = new Set(['lastUpdateDate,desc', 'lastUpdateDate,asc', 'creationDate,desc', 'creationDate,asc'])

function issueSearchTerm(keyword, project) {
  const prefix = ISSUE_NUMBER.exec(keyword)?.[1]
  return prefix && prefix.toLowerCase() === project.code?.toLowerCase()
    ? project.code + keyword.slice(prefix.length)
    : keyword
}

async function findIssueByNumber(client, project, issueNum, body, sort) {
  const expected = issueNum.toLowerCase()
  const [, prefix, number] = ISSUE_NUMBER.exec(issueNum)
  const projectMatches = project.code?.toLowerCase() === prefix.toLowerCase()
  const size = 50
  const maxPages = 5
  for (let page = 0; page < maxPages; page += 1) {
    const data = await client.workList(project.projectId, body, page, size, sort)
    const rows = Array.isArray(data?.content) ? data.content : []
    for (const row of rows) {
      if (!row?.issueId) continue
      const id = String(row.issueNum ?? '')
      if (id.toLowerCase() === expected) return row
      if (String(row.fullIssueNum ?? '').toLowerCase() === expected) return { ...row, issueNum: row.fullIssueNum }
      if (projectMatches && id === number) return { ...row, issueNum }
    }
    if (rows.length < size || page + 1 >= Number(data?.totalPages)) return null
  }
  throw new Error(`前 ${size * maxPages} 条搜索结果中未找到 ${issueNum}，请到猪齿鱼核对`)
}

async function getIssueLookup({ store, client }, request) {
  const settings = await store.load()
  const issueNum = String(paramsOf(request).get('issueNum') || '').trim()
  const prefix = ISSUE_NUMBER.exec(issueNum)?.[1]?.toLowerCase()
  if (!prefix || issueNum.length > 100) return { ok: false, error: '请输入完整工单号，例如 TEAM-123' }
  const matchesPrefix = (item) => String(item.code || '').toLowerCase() === prefix
  const project = settings.projects.find(matchesPrefix) || (await client.allProjects()).find(matchesPrefix)
  if (!project) return { ok: false, error: `当前账号找不到工单号对应的项目：${prefix}` }

  const query = issueSearchTerm(issueNum, project)
  const body = { treeFlag: false, withSubIssues: true, conditions: [keywordCondition(query)] }
  const row = await findIssueByNumber(client, project, query, body)
  return row
    ? { ok: true, project, issue: normalizeIssue(row, project) }
    : { ok: false, error: `在「${project.name || project.code}」找不到 ${issueNum}` }
}

async function resolveMemberFilter(client, projectId, filter) {
  if (!filter?.code) return { warning: '「只看我」未生效：当前项目未配置人员字段。' }
  const predefined = filter.predefined || filter.code === 'assignee'
  try {
    const [self, fields] = await Promise.all([
      client.self(),
      predefined ? [] : client.fieldDefs(projectId),
    ])
    if (!self.id) return { warning: '「只看我」未生效：未能读取当前账号的人员 ID。' }
    const fieldId = predefined ? undefined : fields.find((field) => field.code === filter.code)?.id
    if (!predefined && !fieldId) return { warning: '「只看我」未生效：项目人员字段已失效，请在设置中重新选择。' }
    return { condition: memberCondition({ ...filter, predefined, fieldId }, self.id) }
  } catch {
    return { warning: '「只看我」未生效：人员筛选信息读取失败，可刷新重试。' }
  }
}

async function resolveUnfinishedFilter(client, projectId, types) {
  try {
    const statusIds = await client.unfinishedStatusIds(projectId, types)
    if (statusIds.length > 0) return { condition: statusCondition(statusIds) }
    return { warning: '「只看未完成」未生效：当前项目没有匹配的未完成状态。' }
  } catch {
    return { warning: '「只看未完成」未生效：状态信息读取失败，可刷新重试。' }
  }
}

async function getTasks({ store, client }, request) {
  const settings = await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || settings.defaultProjectId || '')
  if (!projectId) return { ok: false, error: '缺少 projectId' }
  const keyword = String(params.get('keyword') || '').trim()
  const exact = ISSUE_NUMBER.test(keyword)
  const page = exact ? 0 : Math.max(0, Math.trunc(Number(params.get('page')) || 0))
  const size = normalizePageSize(params.get('size'), settings.pageSize)
  const selfOnly = boolParam(params, 'selfOnly', true)
  const unfinished = boolParam(params, 'unfinished', true)
  const rawSince = String(params.get('since') || '').trim()
  const rawUntil = String(params.get('until') || '').trim()
  const requestedSort = String(params.get('sort') || 'lastUpdateDate,desc')
  const sort = LIST_SORTS.has(requestedSort) ? requestedSort : 'lastUpdateDate,desc'
  const project = settings.projects.find((item) => item.projectId === projectId) || {
    projectId,
    code: '',
    name: '',
    filter: null,
  }

  const [member, status] = await Promise.all([
    selfOnly ? resolveMemberFilter(client, projectId, project.filter) : {},
    unfinished ? resolveUnfinishedFilter(client, projectId, settings.unfinishedTypes) : {},
  ])
  const query = issueSearchTerm(keyword, project)
  const conditions = [member.condition, status.condition, keywordCondition(query)].filter(Boolean)
  const warnings = [member.warning, status.warning].filter(Boolean)

  // Creation-date window. Both ends are optional: one missing end is filled
  // from the configured default lookback / today; both empty means "all time".
  let since = validDate(rawSince) ? rawSince : ''
  let until = validDate(rawUntil) ? rawUntil : ''
  let dateActive = false
  if ((rawSince && !since) || (rawUntil && !until)) {
    warnings.push('日期筛选未生效：请输入有效的起止日期。')
  } else if (since || until) {
    if (!since) since = monthsBackDate(settings.defaultLookbackMonths || 3)
    if (!until) until = localToday()
    if (since <= until) {
      conditions.push(dateCondition(since, until))
      dateActive = true
    } else {
      warnings.push('日期筛选未生效：开始日期不能晚于结束日期。')
    }
  }

  const body = { treeFlag: true, withSubIssues: false }
  if (conditions.length > 0) body.conditions = conditions

  let data
  if (exact) {
    const row = await findIssueByNumber(client, project, query, body, sort)
    data = { content: row ? [row] : [], totalElements: row ? 1 : 0, totalPages: 1 }
  } else {
    data = await client.workList(projectId, body, page, size, sort)
  }
  const rows = Array.isArray(data?.content) ? data.content : []
  const total = Number(data?.totalElements ?? rows.length)

  return {
    ok: true,
    items: rows.map((row) => normalizeIssue(row, project)),
    page,
    size,
    total,
    sort,
    totalPages: Math.max(1, Number(data?.totalPages ?? Math.ceil(total / size) ?? 1)),
    filter: {
      selfOnly,
      unfinished,
      selfApplied: Boolean(member.condition),
      unfinishedApplied: Boolean(status.condition),
      label: selfOnly ? project.filter?.name || project.filter?.code || '' : '',
      warning: warnings.length > 0,
      warnings,
      dateActive,
      since: dateActive ? since : '',
      until: dateActive ? until : '',
    },
  }
}

async function getIssue({ store, client, imagePath }, request) {
  const settings = await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  const project = settings.projects.find((item) => item.projectId === projectId)
  const detail = await client.issueDetail(projectId, issueId)
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
      projectName: project?.name || String(detail?.projectName ?? ''),
      projectCode: project?.code || ISSUE_NUMBER.exec(String(detail?.issueNum ?? ''))?.[1] || '',
    },
  }
}

async function buildConsoleUrl(settings, client, project, issueId, issueNum) {
  if (!settings.detailUrlTemplate) return ''
  const numericId = await client.decryptIssueId(project.projectId, issueId)
  const url = detailUrl(settings.detailUrlTemplate, {
    issueId: encodeURIComponent(numericId),
    issueNum: encodeURIComponent(issueNum),
    projectId: encodeURIComponent(project.projectId),
    projectName: encodeURIComponent(project.name || ''),
    category: encodeURIComponent(project.category || ''),
    orgId: encodeURIComponent(settings.organizationId),
  })
  return /^https?:\/\//i.test(url) ? url : ''
}

async function getIssueLink({ store, client }, request) {
  const settings = await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  const project = settings.projects.find((item) => item.projectId === projectId) || {
    projectId,
    name: params.get('projectName') || '',
    category: params.get('category') || '',
  }
  return {
    ok: true,
    consoleUrl: await buildConsoleUrl(settings, client, project, issueId, params.get('issueNum') || ''),
  }
}

async function getIssueTransforms({ store, client }, request) {
  await store.load()
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  const detail = await client.issueDetail(projectId, issueId)
  const statusId = String(detail?.statusVO?.id ?? '')
  const issueTypeId = String(detail?.issueTypeId ?? detail?.issueTypeVO?.id ?? '')
  if (!statusId || !issueTypeId) return { ok: false, error: '工单缺少当前状态或类型，无法查询可用流转。' }
  return {
    ok: true,
    transforms: await client.transforms(projectId, { statusId, issueId, issueTypeId }),
    statusId,
    statusName: String(detail?.statusVO?.name ?? ''),
    statusType: String(detail?.statusVO?.type ?? ''),
    objectVersionNumber: Number(detail?.objectVersionNumber ?? 0),
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

const HANDOFF_PAGE_SIZE = 50
const HANDOFF_MAX_PAGES = 6

async function readHandoffs(client, projectId, issueId, firstPage) {
  const items = []
  const seen = new Set()
  let total = 0
  let scanned = 0
  let scanError = ''
  for (let page = 0; page < HANDOFF_MAX_PAGES; page += 1) {
    let result
    try {
      result = page === 0 && firstPage ? firstPage : await client.comments(projectId, issueId, page, HANDOFF_PAGE_SIZE)
    } catch (error) {
      if (page === 0) throw error
      scanError = error.message
      break
    }
    const comments = Array.isArray(result.items) ? result.items : []
    total = Number(result.total || 0)
    for (const comment of comments) {
      if (comment.commentId) {
        if (seen.has(comment.commentId)) continue
        seen.add(comment.commentId)
      }
      scanned += 1
      const handoff = parseHandoffComment(comment)
      if (handoff) items.push(handoff)
    }
    if (comments.length === 0 || scanned >= total) break
  }
  return {
    items,
    totalComments: total,
    scannedComments: scanned,
    truncated: Boolean(scanError) || scanned < total,
    scanError,
    snapshotAt: new Date().toISOString(),
  }
}

async function getHandoffs({ client }, request) {
  const params = paramsOf(request)
  const projectId = String(params.get('projectId') || '')
  const issueId = String(params.get('issueId') || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  return { ok: true, ...(await readHandoffs(client, projectId, issueId)) }
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
    if (!body.issueId) return { ok: false, error: '缺少 issueId' }
    const text = String(body?.text || '').trim()
    if (!text) return { ok: false, error: '评论内容不能为空' }
    await client.addComment(projectId, String(body?.issueId || ''), text)
  } else if (action === 'update') {
    if (!body.commentId) return { ok: false, error: '缺少 commentId' }
    const text = String(body?.text || '').trim()
    if (!text) return { ok: false, error: '评论内容不能为空' }
    await client.updateComment(projectId, {
      commentId: String(body?.commentId || ''),
      objectVersionNumber: Number(body?.objectVersionNumber || 0),
      text,
    })
  } else if (action === 'delete') {
    if (!body.commentId) return { ok: false, error: '缺少 commentId' }
    await client.deleteComment(projectId, String(body?.commentId || ''))
  } else {
    return { ok: false, error: `未知操作：${action}` }
  }
  return { ok: true }
}

async function postHandoffTemplate({ store, client }, request) {
  const body = await readBody(request)
  const projectId = String(body?.projectId || '')
  const issueId = String(body?.issueId || '')
  const role = String(body?.role || '')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  if (!Object.hasOwn(HANDOFF_ROLES, role)) return { ok: false, error: '请选择有效的交接角色' }
  const [settings, detail] = await Promise.all([store.load(), client.issueDetail(projectId, issueId)])
  const project = settings.projects.find((item) => item.projectId === projectId) || {}
  const issue = {
    issueNum: String(detail?.issueNum || ''),
    summary: String(detail?.summary || ''),
    projectId,
    projectCode: String(project.code || ''),
    projectName: String(project.name || detail?.projectName || ''),
  }
  return { ok: true, role, title: HANDOFF_ROLES[role].label, text: buildHandoffTemplate(role, issue) }
}

function handoffDigest(text) {
  return createHash('sha256').update(normalizeHandoffText(text)).digest('hex')
}

function createHandoffPublisher(client) {
  const pending = new Map()
  const active = new Set()
  const headers = new Set(Object.values(HANDOFF_ROLES).map(({ label }) => `【阶段交接 v1｜${label}】`))
  const receiptLifetime = 30 * 60 * 1000

  async function verifyReceipt(receipt) {
    const { projectId, issueId, commentId, knownIds, author, submittedAt, digest, authentication } = receipt
    client.assertAuthentication(authentication)
    if (!commentId && (!knownIds || !author)) return null
    const latest = await client.comments(projectId, issueId, 0, HANDOFF_PAGE_SIZE)
    client.assertAuthentication(authentication)
    const matches = latest.items.filter((item) => {
      if (commentId) return item.commentId === commentId
      const createdAt = Date.parse(item.creationDate)
      return item.commentId && !knownIds.has(item.commentId) &&
        item.loginName === author &&
        createdAt >= submittedAt - 5000 && createdAt <= submittedAt + 60000 &&
        handoffDigest(item.text) === digest
    })
    return matches.length === 1 ? parseHandoffComment(matches[0]) : null
  }

  async function resultFor(key, receipt) {
    try {
      const handoff = await verifyReceipt(receipt)
      if (handoff) {
        return { ok: true, verified: true, handoff, message: '交接记录已发布并回读核实' }
      }
    } catch {
      // A write may already be committed even when read-back fails.
    }
    const message = receipt.acknowledged
      ? '发布请求已成功返回，暂未核实新评论。请刷新核实，避免重复提交。'
      : '发布结果暂不确定。请刷新核实，避免重复提交。'
    return { ok: true, verified: false, handoff: null, receipt: key, message }
  }

  return {
    async publish(request) {
      const body = await readBody(request)
      const projectId = String(body.projectId || '')
      const issueId = String(body.issueId || '')
      const text = String(body.text || '').trim()
      if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
      if (!headers.has(text.split(/\r?\n/, 1)[0])) {
        return { ok: true, rejected: true, verified: false, message: '交接首行必须是有效的「【阶段交接 v1｜角色】」标记' }
      }
      const authentication = client.authenticationState()
      const operation = JSON.stringify([projectId, issueId])
      if (active.has(operation)) {
        return { ok: true, rejected: true, verified: false, message: '该工单已有交接正在发布，请等待结果。' }
      }
      active.add(operation)
      try {
        const [before, self] = await Promise.all([
          client.comments(projectId, issueId, 0, HANDOFF_PAGE_SIZE).catch(() => null),
          client.self().catch(() => null),
        ])
        client.assertAuthentication(authentication)
        const submittedAt = Date.now()
        let commentId = ''
        let acknowledged = false
        try {
          const created = await client.addComment(projectId, issueId, text)
          commentId = String(created?.commentId ?? created?.id ?? '')
          acknowledged = true
        } catch (error) {
          if ([400, 401, 403, 404, 409, 413, 422].includes(error.status)) {
            return { ok: true, rejected: true, verified: false, message: `发布被拒绝：${error.message}` }
          }
        }
        for (const [key, receipt] of pending) {
          if (receipt.submittedAt + receiptLifetime <= submittedAt || receipt.authentication !== authentication) {
            pending.delete(key)
          }
        }
        if (pending.size >= 100) pending.delete(pending.keys().next().value)
        const key = randomUUID()
        const receipt = {
          projectId,
          issueId,
          commentId,
          submittedAt,
          acknowledged,
          author: self?.loginName || '',
          knownIds: before ? new Set(before.items.map((item) => item.commentId)) : null,
          digest: handoffDigest(text),
          authentication,
        }
        pending.set(key, receipt)
        return await resultFor(key, receipt)
      } finally {
        active.delete(operation)
      }
    },
    async verify(request) {
      const body = await readBody(request)
      const key = String(body.receipt || '')
      const receipt = pending.get(key)
      if (!receipt || receipt.submittedAt + receiptLifetime <= Date.now() ||
          receipt.authentication !== client.authenticationState() ||
          receipt.projectId !== String(body.projectId || '') ||
          receipt.issueId !== String(body.issueId || '') ||
          receipt.digest !== handoffDigest(body.text)) {
        return { ok: true, verified: false, message: '核实凭据已失效或与工单不符，请在猪齿鱼查看该条评论。' }
      }
      return resultFor(key, receipt)
    },
  }
}

async function postDispatchConfirm({ store, client }, request) {
  const body = await readBody(request)
  const settings = await store.load()
  const projectId = String(body?.projectId || '')
  if (!projectId) return { ok: false, error: '缺少 projectId' }
  const project = settings.projects.find((item) => item.projectId === projectId)
    || (await client.allProjects()).find((item) => item.projectId === projectId)
  if (!project) return { ok: false, error: '找不到派发对应的项目' }
  const directory = dispatchDirectory(settings, project)
  await fs.mkdir(directory, { recursive: true })
  return { ok: true, dir: directory }
}

function dispatchDirectory(settings, project) {
  const code = String(project.code || project.projectId).replace(/[^A-Za-z0-9._-]/g, '_')
  const safeCode = code.length > 0 && code !== '.' && code !== '..' ? code : `project-${code}`
  const sessionRoot = String(settings.sessionRoot || '').trim() || path.join(os.homedir(), 'choerodon-sessions')
  return path.join(sessionRoot, safeCode)
}

async function postDispatch({ store, client }, request) {
  const body = await readBody(request)
  const settings = await store.load()
  const projectId = String(body?.projectId || '')
  const issueId = String(body?.issueId || '')
  const kind = String(body?.kind || 'bug')
  if (!projectId || !issueId) return { ok: false, error: '缺少 projectId 或 issueId' }
  if (!DISPATCH_KINDS.includes(kind)) return { ok: false, error: `未知处理类型：${kind}` }

  const [detail, commentPage, project] = await Promise.all([
    client.issueDetail(projectId, issueId),
    client.comments(projectId, issueId, 0, HANDOFF_PAGE_SIZE).catch(() => null),
    settings.projects.find((item) => item.projectId === projectId)
      || client.allProjects().then((items) => items.find((item) => item.projectId === projectId)),
  ])
  if (!project) return { ok: false, error: '找不到派发对应的项目' }
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
  const commentLimit = kind === 'design' ? 20 : 10
  const descriptionLimit = kind === 'design' ? 8000 : 4000
  const comments = (commentPage?.items || []).filter((item) => !parseHandoffComment(item)).slice(0, commentLimit)
  const [consoleUrl, handoffData] = await Promise.all([
    buildConsoleUrl(settings, client, project, issueId, issue.issueNum),
    commentPage ? readHandoffs(client, projectId, issueId, commentPage) : null,
  ])
  const handoffs = handoffData?.items || []
  const handoffsTruncated = Boolean(handoffData?.truncated)
  const commentsUnavailable = !commentPage
  const handoffsUnavailable = !handoffData
  const { title, prompt } = buildBrief({
    issue,
    kind,
    orgId: settings.organizationId,
    consoleUrl,
    comments,
    commentsUnavailable,
    commentLimit,
    descriptionLimit,
    handoffs,
    handoffsTruncated,
    handoffsUnavailable,
  })

  const directory = dispatchDirectory(settings, project)

  return {
    ok: true,
    projectId,
    issueId,
    kind,
    title,
    prompt,
    dir: directory,
    mode: settings.dispatchMode,
    context: {
      descriptionIncluded: Boolean(htmlToText(String(detail?.description ?? ''), descriptionLimit).trim()),
      descriptionTruncated: htmlToText(String(detail?.description ?? ''), descriptionLimit).endsWith('…（内容已截断）'),
      descriptionLimit,
      commentsIncluded: comments.length,
      commentsTotal: commentPage?.total ?? null,
      commentsUnavailable,
      commentLimit,
      commentsTruncatedCount: comments.filter((item) => htmlToText(String(item.text || ''), 1200).endsWith('…（内容已截断）')).length,
      attachmentCount: issue.attachments.length,
      handoffCount: handoffs.length,
      handoffContextIncludedCount: Math.min(handoffs.length, 8),
      handoffContextOmittedCount: Math.max(0, handoffs.length - 8),
      handoffSourceTruncatedCount: handoffs.filter((item) => item.truncated).length,
      handoffsTruncated,
      handoffsUnavailable,
      snapshotAt: new Date().toISOString(),
    },
  }
}
