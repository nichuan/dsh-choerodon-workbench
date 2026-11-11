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
    this.memo = { token: null, scope: null, fetchedAt: 0 }
    this.loginPromise = null
    this.cache = new Map()
  }

  base() {
    return String(this.getSettings().baseUrl || '').replace(/\/+$/, '')
  }

  orgId() {
    return String(this.getSettings().organizationId || '1')
  }

  tenantId() {
    return String(this.getSettings().tenantId || '1')
  }

  cacheGet(key) {
    const hit = this.cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(key)
      return undefined
    }
    return hit.value
  }

  cacheSet(key, value) {
    this.cache.set(key, { at: Date.now(), value })
    return value
  }

  /** Drop every cached response (after a settings change or a 401). */
  invalidate(prefix) {
    if (!prefix) {
      this.cache.clear()
      return
    }
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
  }

  clearToken() {
    this.memo = { token: null, scope: null, fetchedAt: 0 }
    this.invalidate('self')
  }

  /** Test seam: install a token without running the login flow. */
  useToken(token) {
    const settings = this.getSettings()
    this.memo = {
      token,
      scope: `${this.base()}|${settings.username}|${this.tenantId()}`,
      fetchedAt: Date.now(),
    }
  }

  tokenScope() {
    const settings = this.getSettings()
    return `${this.base()}|${settings.username}|${this.tenantId()}`
  }

  async token(force = false) {
    const scope = this.tokenScope()
    if (!force && this.memo.token && this.memo.scope === scope && Date.now() - this.memo.fetchedAt < TOKEN_TTL_MS) {
      return this.memo.token
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login()
        .then((token) => {
          this.memo = { token, scope: this.tokenScope(), fetchedAt: Date.now() }
          return token
        })
        .finally(() => {
          this.loginPromise = null
        })
    }
    return this.loginPromise
  }

  /** Four-step Choerodon OAuth login: public key, RSA password, 302, access_token. */
  async login() {
    const settings = this.getSettings()
    if (!settings.username || !settings.password) {
      throw new Error('未配置猪齿鱼账号或密码，请到设置页填写')
    }
    const base = this.base()
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)

    const page = await fetch(`${base}/oauth/choerodon/login`, {
      headers: { 'user-agent': UA },
      redirect: 'manual',
      signal,
    })
    const html = await page.text()
    const match = /data-publicKey="([^"]+)"/.exec(html)
    if (!match || !match[1]) {
      throw new Error('登录失败：登录页没有 RSA 公钥，请检查网关地址')
    }
    let cookies = cookieMap(page)

    const body = new URLSearchParams({
      username: settings.username,
      password: encryptPassword(settings.password, match[1]),
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

  async request(pathname, { method = 'GET', body, retry = true } = {}) {
    const token = await this.token()
    const headers = {
      accept: 'application/json',
      authorization: `bearer ${token}`,
      'h-menu-id': '0',
      'h-tenant-id': this.tenantId(),
      'user-agent': UA,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }
    const response = await fetch(`${this.base()}${pathname}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let data = null
    if (text.trim()) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (response.status === 401 && retry) {
      this.clearToken()
      return this.request(pathname, { method, body, retry: false })
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
    const cached = this.cacheGet('self')
    if (cached) return cached
    const data = await this.request('/iam/choerodon/v1/users/self')
    return this.cacheSet('self', {
      id: String(data?.id ?? ''),
      realName: String(data?.realName ?? ''),
      loginName: String(data?.loginName ?? ''),
      email: String(data?.email ?? ''),
    })
  }

  // ---------------------------------------------------------------- projects

  async starProjects() {
    const data = await this.request(`/cbase/choerodon/v1/organizations/${this.orgId()}/star_projects`)
    return listOf(data).map(normalizeProject)
  }

  async allProjects() {
    const cached = this.cacheGet('projects')
    if (cached) return cached
    const self = await this.self()
    const data = await this.request(
      `/cbase/choerodon/v1/organizations/${this.orgId()}/users/${enc(self.id)}/projects/paging?page=0&size=400&params=`,
      { method: 'POST', body: {} },
    )
    const projects = listOf(data).map(normalizeProject).filter((item) => item.projectId)
    return this.cacheSet('projects', projects)
  }

  // ---------------------------------------------------------- project config

  async fieldDefs(projectId) {
    const key = `fields:${projectId}`
    const cached = this.cacheGet(key)
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
    return this.cacheSet(key, fields)
  }

  async memberFields(projectId) {
    const fields = await this.fieldDefs(projectId)
    return fields.filter((field) => /member/i.test(field.fieldType))
  }

  async statuses(projectId) {
    const key = `statuses:${projectId}`
    const cached = this.cacheGet(key)
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
    return this.cacheSet(key, list)
  }

  async unfinishedStatusIds(projectId, types) {
    const wanted = new Set((types && types.length ? types : ['todo', 'doing']).map((item) => String(item)))
    const statuses = await this.statuses(projectId)
    return statuses.filter((item) => wanted.has(item.type)).map((item) => item.id)
  }

  // ------------------------------------------------------------------ issues

  async workList(projectId, body, page = 0, size = 20) {
    return this.request(`/agile/v2/projects/${projectId}/issues/work_list?page=${page}&size=${size}`, {
      method: 'POST',
      body,
    })
  }

  async baselineTotal(projectId) {
    const key = `baseline:${projectId}`
    const cached = this.cacheGet(key)
    if (cached !== undefined) return cached
    const data = await this.workList(projectId, { treeFlag: true, withSubIssues: false }, 0, 1)
    const total = Number(data?.totalElements ?? 0)
    return this.cacheSet(key, Number.isFinite(total) ? total : 0)
  }

  async issueDetail(projectId, issueId) {
    return this.request(
      `/agile/v1/projects/${projectId}/issues/${enc(issueId)}?organizationId=${this.orgId()}&instanceProjectId=${projectId}`,
    )
  }

  async decryptIssueId(projectId, issueId) {
    if (/^\d+$/.test(String(issueId))) return String(issueId)
    const key = `decrypt:${projectId}:${issueId}`
    const cached = this.cacheGet(key)
    if (cached) return cached
    try {
      const data = await this.request(
        `/agile/v1/projects/${projectId}/decrypt?issueId=${enc(issueId)}`,
      )
      const text = typeof data === 'string' ? data.trim() : ''
      if (/^\d+$/.test(text)) return this.cacheSet(key, text)
      if (data && typeof data === 'object') {
        for (const field of ['issueId', 'id', 'content', 'data']) {
          const value = data[field]
          if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) {
            return this.cacheSet(key, String(value))
          }
        }
      }
    } catch {
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
  const looksLikeNumber = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/.test(query) || /^\d{3,}$/.test(query)
  return {
    field: {
      fieldCode: looksLikeNumber ? 'issueNum' : 'content',
      predefined: true,
      fieldType: 'input',
      name: looksLikeNumber ? '工单号' : '概要',
    },
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
