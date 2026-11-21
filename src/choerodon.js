import crypto from 'node:crypto'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30000
const CACHE_TTL_MS = 10 * 60 * 1000

/** RSA-PKCS1v15 encryption of the password with the login page's SPKI public key. */
function encryptPassword(password, publicKeyBase64) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  return crypto
    .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8'))
    .toString('base64')
}

function cookieMap(response) {
  const map = {}
  const extended = response.headers
  let entries = []
  if (typeof extended.getSetCookie === 'function') entries = extended.getSetCookie()
  if (!entries || entries.length === 0) {
    const single = response.headers.get('set-cookie')
    if (single) entries = [single]
  }
  for (const entry of entries) {
    const first = entry.split(';', 1)[0] || ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const key = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!key) continue
    map[key] = value
  }
  return map
}

function mergeCookies(a, b) {
  return { ...a, ...b }
}

function cookieHeader(map) {
  return Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

const enc = (value) => encodeURIComponent(String(value ?? ''))

function listOf(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.content)) return data.content
  if (data && Array.isArray(data.list)) return data.list
  return []
}

function readName(value) {
  if (!value || typeof value !== 'object') return ''
  return String(value.name ?? value.realName ?? value.loginName ?? '')
}

/** Read-only-ish Choerodon API client with an in-memory token cache. */
export class ChoerodonClient {
  constructor(getSettings) {
    this.getSettings = getSettings
    this.authentication = null
  }

  authenticationState() {
    const settings = this.getSettings()
    const base = String(settings.baseUrl || '').trim().replace(/\/+$/, '')
    const organizationId = String(settings.organizationId || '1')
    const tenantId = String(settings.tenantId || '1')
    const { username, password } = settings
    const current = this.authentication
    if (
      current?.base === base && current.organizationId === organizationId &&
      current.tenantId === tenantId && current.username === username && current.password === password
    ) {
      return current
    }
    this.authentication = {
      base, organizationId, tenantId, username, password,
      memo: null,
      loginPromise: null,
      cache: new Map(),
    }
    return this.authentication
  }

  assertAuthentication(authentication) {
    if (this.authenticationState() !== authentication) {
      throw new Error('猪齿鱼连接配置已变更，请刷新并核实操作结果')
    }
  }

  resetAuthentication() {
    this.authentication = null
  }

  base() {
    return this.authenticationState().base
  }

  orgId() {
    return this.authenticationState().organizationId
  }

  tenantId() {
    return this.authenticationState().tenantId
  }

  cacheGet(key, authentication = this.authenticationState()) {
    const hit = authentication.cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      authentication.cache.delete(key)
      return undefined
    }
    return hit.value
  }

  cacheSet(key, value, authentication = this.authenticationState()) {
    this.assertAuthentication(authentication)
    authentication.cache.set(key, { at: Date.now(), value })
    return value
  }

  /** Drop every cached response (after a settings change or a 401). */
  invalidate(prefix) {
    const { cache } = this.authenticationState()
    if (!prefix) {
      cache.clear()
      return
    }
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
  }

  clearToken(token, authentication = this.authenticationState()) {
    if (token !== undefined && authentication.memo?.token !== token) return
    authentication.memo = null
    authentication.cache.delete('self')
  }

  /** Test seam: install a token without running the login flow. */
  useToken(token) {
    this.authenticationState().memo = { token, fetchedAt: Date.now() }
  }

  async token(force = false, authentication = this.authenticationState()) {
    this.assertAuthentication(authentication)
    const { memo } = authentication
    if (!force && memo?.token && Date.now() - memo.fetchedAt < TOKEN_TTL_MS) {
      return memo.token
    }
    if (!authentication.loginPromise) {
      authentication.loginPromise = this.login(authentication)
        .then((token) => {
          this.assertAuthentication(authentication)
          authentication.memo = { token, fetchedAt: Date.now() }
          return token
        })
        .finally(() => {
          authentication.loginPromise = null
        })
    }
    return authentication.loginPromise
  }

  /** Four-step Choerodon OAuth login: public key, RSA password, 302, access_token. */
  async login(authentication = this.authenticationState()) {
    const { base, username, password } = authentication
    if (!username || !password) {
      throw new Error('未配置猪齿鱼账号或密码，请到设置页填写')
    }
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)

    const page = await fetch(`${base}/oauth/choerodon/login`, {
      headers: { 'user-agent': UA },
      redirect: 'manual',
      signal,
    })
    const html = await page.text()
    this.assertAuthentication(authentication)
    const match = /data-publicKey="([^"]+)"/.exec(html)
    if (!match || !match[1]) {
      const snippet = html.replace(/\s+/g, ' ').trim().slice(0, 200)
      const hint =
        page.status !== 200
          ? `HTTP ${page.status}（可能被网关或公司代理重定向/拦截）`
          : 'HTTP 200 但页面异常（可能当前网络走了公司代理、WAF 或内网 DNS，返回了别的页面）'
      throw new Error(
        `登录失败：登录页没有 RSA 公钥（${hint}）。返回内容片段：${snippet || '(空响应)'}`
      )
    }
    let cookies = cookieMap(page)

    const body = new URLSearchParams({
      username,
      password: encryptPassword(password, match[1]),
    })
    const posted = await fetch(`${base}/oauth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        origin: base,
        referer: `${base}/oauth/choerodon/login`,
        ...(Object.keys(cookies).length > 0 ? { cookie: cookieHeader(cookies) } : {}),
      },
      body: body.toString(),
      redirect: 'manual',
      signal,
    })
    this.assertAuthentication(authentication)
    cookies = mergeCookies(cookies, cookieMap(posted))

    let location = posted.headers.get('location')
    if (!location) {
      const detail = await posted.text().catch(() => '')
      throw new Error(`登录失败：账号密码错误或平台不可用（HTTP ${posted.status}）${detail ? '' : ''}`)
    }

    let current = location.startsWith('http') ? location : `${base}${location}`
    for (let hop = 0; hop < 6; hop += 1) {
      const early = /access_token=([^&#]+)/.exec(current)
      if (early) return early[1]
      const res = await fetch(current, {
        headers: {
          'user-agent': UA,
          ...(Object.keys(cookies).length > 0 ? { cookie: cookieHeader(cookies) } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      this.assertAuthentication(authentication)
      cookies = mergeCookies(cookies, cookieMap(res))
      const next = res.headers.get('location')
      if (next) {
        const fromNext = /access_token=([^&#]+)/.exec(next)
        if (fromNext) return fromNext[1]
        current = next.startsWith('http') ? next : `${base}${next}`
        continue
      }
      const fromFinal = /access_token=([^&#]+)/.exec(res.url || current)
      if (fromFinal) return fromFinal[1]
      break
    }
    throw new Error('登录失败：未能从重定向链拿到 access_token')
  }

  async request(pathname, { method = 'GET', body, retry = true } = {}, authentication = this.authenticationState()) {
    const token = await this.token(false, authentication)
    this.assertAuthentication(authentication)
    const headers = {
      accept: 'application/json',
      authorization: `bearer ${token}`,
      'h-menu-id': '0',
      'h-tenant-id': authentication.tenantId,
      'user-agent': UA,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }
    const response = await fetch(`${authentication.base}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    this.assertAuthentication(authentication)
    let data = null
    if (text.trim()) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (response.status === 401 && retry) {
      this.clearToken(token, authentication)
      return this.request(pathname, { method, body, retry: false }, authentication)
    }
    if (!response.ok) {
      const message =
        (data && typeof data === 'object' && (data.message || data.error_description || data.code)) ||
        `请求失败（HTTP ${response.status}）`
      const error = new Error(String(message))
      error.status = response.status
      error.data = data
      throw error
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && data.failed) {
      const error = new Error(String(data.message || data.code || '接口返回失败'))
      error.status = 200
      error.data = data
      throw error
    }
    return data
  }

  // ---------------------------------------------------------------- identity

  async self() {
    const authentication = this.authenticationState()
    const cached = this.cacheGet('self', authentication)
    if (cached) return cached
    const data = await this.request('/iam/choerodon/v1/users/self')
    return this.cacheSet('self', {
      id: String(data?.id ?? ''),
      realName: String(data?.realName ?? ''),
      loginName: String(data?.loginName ?? ''),
      email: String(data?.email ?? ''),
    }, authentication)
  }

  // ---------------------------------------------------------------- projects

  async starProjects() {
    const data = await this.request(`/cbase/choerodon/v1/organizations/${this.orgId()}/star_projects`)
    return listOf(data).map(normalizeProject)
  }

  async allProjects() {
    const authentication = this.authenticationState()
    const cached = this.cacheGet('projects', authentication)
    if (cached) return cached
    const self = await this.self()
    const data = await this.request(
      `/cbase/choerodon/v1/organizations/${authentication.organizationId}/users/${enc(self.id)}/projects/paging?page=0&size=400&params=`,
      { method: 'POST', body: {} },
      authentication,
    )
    const projects = listOf(data).map(normalizeProject).filter((item) => item.projectId)
    return this.cacheSet('projects', projects, authentication)
  }

  // ---------------------------------------------------------- project config

  async fieldDefs(projectId) {
    const key = `fields:${projectId}`
    const authentication = this.authenticationState()
    const cached = this.cacheGet(key, authentication)
    if (cached) return cached
    const data = await this.request(
      `/agile/v1/projects/${projectId}/object_scheme_field/list?organizationId=${this.orgId()}&schemeCode=agile_issue`,
    )
    const fields = listOf(data).map((field) => ({
      id: String(field.id ?? ''),
      code: String(field.code ?? ''),
      name: String(field.name ?? ''),
      fieldType: String(field.fieldType ?? ''),
      system: Boolean(field.system),
      issueTypes: (Array.isArray(field.issueTypeVOList) ? field.issueTypeVOList : [])
        .map((item) => String(item.typeCode ?? item.code ?? ''))
        .filter(Boolean),
    }))
    return this.cacheSet(key, fields, authentication)
  }

  async memberFields(projectId) {
    const fields = await this.fieldDefs(projectId)
    return fields.filter((field) => /member/i.test(field.fieldType))
  }

  async statuses(projectId) {
    const key = `statuses:${projectId}`
    const authentication = this.authenticationState()
    const cached = this.cacheGet(key, authentication)
    if (cached) return cached
    const data = await this.request(
      `/agile/v1/projects/${projectId}/schemes/query_status_by_project_id?apply_type=agile`,
    )
    const list = listOf(data)
      .map((item) => ({
        id: String(item.id ?? ''),
        name: String(item.name ?? ''),
        type: String(item.type ?? ''),
      }))
      .filter((item) => item.id && item.name)
    return this.cacheSet(key, list, authentication)
  }

  async unfinishedStatusIds(projectId, types) {
    const wanted = new Set((types && types.length ? types : ['todo', 'doing']).map((item) => String(item)))
    const statuses = await this.statuses(projectId)
    return statuses.filter((item) => wanted.has(item.type)).map((item) => item.id)
  }

  // ------------------------------------------------------------------ issues

  async workList(projectId, body, page = 0, size = 20, sort = 'lastUpdateDate,desc') {
    const allowedSorts = new Set([
      'lastUpdateDate,desc',
      'lastUpdateDate,asc',
      'creationDate,desc',
      'creationDate,asc',
    ])
    const safeSort = allowedSorts.has(sort) ? sort : 'lastUpdateDate,desc'
    return this.request(
      `/agile/v2/projects/${projectId}/issues/work_list?page=${page}&size=${size}&sort=${encodeURIComponent(safeSort)}`,
      { method: 'POST', body },
    )
  }

  async baselineTotal(projectId) {
    const key = `baseline:${projectId}`
    const authentication = this.authenticationState()
    const cached = this.cacheGet(key, authentication)
    if (cached !== undefined) return cached
    const data = await this.workList(projectId, { treeFlag: true, withSubIssues: false }, 0, 1)
    const total = Number(data?.totalElements ?? 0)
    return this.cacheSet(key, Number.isFinite(total) ? total : 0, authentication)
  }

  async issueDetail(projectId, issueId) {
    return this.request(
      `/agile/v1/projects/${projectId}/issues/${enc(issueId)}?organizationId=${this.orgId()}&instanceProjectId=${projectId}`,
    )
  }

  async decryptIssueId(projectId, issueId) {
    if (/^\d+$/.test(String(issueId))) return String(issueId)
    const key = `decrypt:${projectId}:${issueId}`
    const authentication = this.authenticationState()
    const cached = this.cacheGet(key, authentication)
    if (cached) return cached
    try {
      const data = await this.request(
        `/agile/v1/projects/${projectId}/decrypt?issueId=${enc(issueId)}`,
      )
      const text = typeof data === 'string' ? data.trim() : ''
      if (/^\d+$/.test(text)) return this.cacheSet(key, text, authentication)
      if (data && typeof data === 'object') {
        for (const field of ['issueId', 'id', 'content', 'data']) {
          const value = data[field]
          if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) {
            return this.cacheSet(key, String(value), authentication)
          }
        }
      }
    } catch {
      this.assertAuthentication(authentication)
      // Fall back to the encrypted id; the console re-encrypts numeric ids on its own.
    }
    return String(issueId)
  }

  // ---------------------------------------------------------- state machine

  async transforms(projectId, { statusId, issueId, issueTypeId }) {
    const data = await this.request(
      `/agile/v1/projects/${projectId}/schemes/query_transforms?current_status_id=${enc(statusId)}&issue_id=${enc(issueId)}&issue_type_id=${enc(issueTypeId)}&apply_type=agile`,
    )
    return listOf(data).map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? ''),
      targetStatusId: String(item.statusVO?.id ?? item.endStatusId ?? ''),
      targetStatusName: String(item.statusVO?.name ?? ''),
      targetStatusType: String(item.statusVO?.type ?? ''),
    }))
  }

  async updateStatus(projectId, { transformId, issueId, objectVersionNumber }) {
    return this.request(
      `/agile/v1/projects/${projectId}/issues/update_status?transformId=${enc(transformId)}&issueId=${enc(issueId)}&objectVersionNumber=${enc(objectVersionNumber)}&applyType=agile`,
      { method: 'PUT' },
    )
  }

  // ---------------------------------------------------------------- comments

  async comments(projectId, issueId, page = 0, size = 20) {
    const data = await this.request(
      `/agile/v1/projects/${projectId}/issue_comment/issue/${enc(issueId)}/page?page=${page}&size=${size}&sort=creationDate,desc`,
    )
    const items = listOf(data).map((item) => ({
      commentId: String(item.commentId ?? ''),
      text: String(item.commentText ?? ''),
      user: String(item.userRealName ?? item.userName ?? ''),
      loginName: String(item.userLoginName ?? ''),
      creationDate: String(item.creationDate ?? ''),
      lastUpdateDate: String(item.lastUpdateDate ?? ''),
      objectVersionNumber: Number(item.objectVersionNumber ?? 0),
      replySize: Number(item.replySize ?? 0),
    }))
    return {
      items,
      total: Number(data?.totalElements ?? items.length),
      totalPages: Number(data?.totalPages ?? 1),
      page: Number(data?.number ?? page),
      size: Number(data?.size ?? size),
    }
  }

  async addComment(projectId, issueId, text) {
    return this.request(`/agile/v1/projects/${projectId}/issue_comment`, {
      method: 'POST',
      body: { issueId, commentText: text },
    })
  }

  async updateComment(projectId, { commentId, objectVersionNumber, text }) {
    return this.request(`/agile/v1/projects/${projectId}/issue_comment/self/update`, {
      method: 'POST',
      body: { commentId, objectVersionNumber, commentText: text },
    })
  }

  async deleteComment(projectId, commentId) {
    return this.request(`/agile/v1/projects/${projectId}/issue_comment/self/${enc(commentId)}`, {
      method: 'DELETE',
    })
  }
}

function normalizeProject(raw) {
  return {
    projectId: String(raw?.id ?? raw?.projectId ?? ''),
    name: String(raw?.name ?? raw?.projectName ?? ''),
    code: String(raw?.code ?? raw?.projectCode ?? ''),
    category: String(raw?.category ?? ''),
    organizationId: String(raw?.organizationId ?? ''),
    enabled: raw?.enabled !== false,
    starFlag: Boolean(raw?.starFlag),
  }
}

/** Build the `conditions` entry that filters an issue list by one person. */
export function memberCondition(field, personId) {
  const custom = !field.predefined && field.code !== 'assignee'
  return {
    field: {
      fieldCode: field.code,
      ...(custom ? { fieldId: field.fieldId } : {}),
      fieldType: field.fieldType || 'member',
      predefined: Boolean(field.predefined),
      name: field.name,
    },
    relationship: 'AND',
    operation: 'IN',
    value: { valueIdList: [personId] },
  }
}

/** Build the `conditions` entry that filters an issue list by status ids. */
export function statusCondition(statusIds) {
  return {
    field: { fieldCode: 'status', fieldType: 'multiple', predefined: true, name: '状态' },
    relationship: 'AND',
    operation: 'IN',
    value: { valueIdList: statusIds },
  }
}

/** Build the `conditions` entry for a creation-date range (inclusive days, YYYY-MM-DD). */
export function dateCondition(since, until) {
  return {
    field: { fieldCode: 'creationDate', fieldType: 'datetime', predefined: true, name: '创建时间' },
    relationship: 'AND',
    operation: 'BETWEEN',
    betweenValues: {
      first: { valueDate: `${since} 00:00:00` },
      second: { valueDate: `${until} 23:59:59` },
    },
  }
}

/** Build the `conditions` entry for a keyword search on issue number or summary. */
export function keywordCondition(keyword) {
  const query = String(keyword || '').trim()
  if (!query) return null
  return {
    field: { fieldCode: 'content', predefined: true, fieldType: 'input', name: '概要' },
    relationship: 'AND',
    value: { valueStr: query },
    operation: 'LIKE',
  }
}

/** Normalize one work-list row for the client. */
export function normalizeIssue(row, project) {
  return {
    issueId: String(row?.issueId ?? ''),
    issueNum: String(row?.issueNum ?? ''),
    summary: String(row?.summary ?? ''),
    statusName: readName(row?.statusVO),
    statusType: String(row?.statusVO?.type ?? row?.statusMapVO?.type ?? ''),
    statusId: String(row?.statusVO?.id ?? row?.statusMapVO?.id ?? ''),
    typeCode: String(row?.typeCode ?? ''),
    typeName: readName(row?.issueTypeVO),
    parentId: String(row?.parentId ?? ''),
    priority: readName(row?.priorityVO),
    assignee: String(row?.assigneeRealName ?? row?.assigneeName ?? ''),
    reporter: String(row?.reporterRealName ?? row?.reporterName ?? ''),
    creationDate: String(row?.creationDate ?? ''),
    lastUpdateDate: String(row?.lastUpdateDate ?? ''),
    objectVersionNumber: Number(row?.objectVersionNumber ?? 0),
    projectId: String(row?.projectId ?? project?.projectId ?? ''),
    projectName: String(row?.projectName ?? project?.name ?? ''),
    projectCode: project?.code || '',
  }
}

export { readName, listOf }
