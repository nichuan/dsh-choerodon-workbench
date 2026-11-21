import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')
const { ChoerodonClient } = await import('../src/choerodon.js')
const { createImageProxy } = await import('../src/images.js')
const { createSettingsStore } = await import('../src/settings.js')
const settings = createSettingsStore()
await settings.save({
  baseUrl: 'https://fixture.invalid',
  pageSize: 50,
  projects: [
    {
      projectId: '101',
      code: 'ops',
      name: 'Operations',
      filter: { code: 'assignee', predefined: true },
    },
    {
      projectId: '102',
      code: 'support-team',
      name: 'Support',
      filter: { code: 'technicalOwner', fieldType: 'member', predefined: false },
    },
  ],
  detailUrlTemplate: 'https://console.fixture.invalid/issues?paramIssueId={issueId}',
  password: 'fixture-only-password',
  sessionRoot: path.join(home, 'sessions'),
})
globalThis.fetch = () => assert.fail('Outbound requests must be mocked')
after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 3 }))

const projectId = '101'
const issueId = 'encrypted-issue-fixture'
const comment = {
  commentId: 'old-comment',
  loginName: 'fixture-user',
  creationDate: '2020-01-01T00:00:00Z',
  text: '【阶段交接 v1｜研发提测】\n\n已经补齐离线测试材料',
}
const issue = {
  issueId,
  issueNum: 'OPS-123',
  issueTypeId: 'type-fixture',
  statusVO: { id: 'status-fixture', name: '待处理', type: 'todo' },
  objectVersionNumber: 7,
}

function host() {
  const routes = new Map()
  apply({
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    effect: (run) => run(),
    get: () => null,
  })
  return async (endpoint, data) => {
    const pathname = `/api/choerodon/${endpoint}`
    const route = routes.get(pathname.split('?')[0])
    const method = data === undefined ? 'GET' : 'POST'
    assert.deepEqual(route.methods, [method])
    const response = await route.fetch(new Request(`http://fixture.invalid${pathname}`, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    }))
    return response.json()
  }
}

test('lists expose filters that could not actually be applied and honor the saved page size', async (t) => {
  t.mock.method(ChoerodonClient.prototype, 'self', async () => ({ id: 'me' }))
  t.mock.method(ChoerodonClient.prototype, 'unfinishedStatusIds', async () => { throw new Error('status unavailable') })
  t.mock.method(ChoerodonClient.prototype, 'workList', async (_project, body, _page, size) => {
    assert.equal(size, 50)
    assert.deepEqual(body.conditions.map(({ field }) => field.fieldCode), ['assignee'])
    return { content: [issue] }
  })
  const result = await host()('tasks?projectId=101&since=2026-02-31')
  assert.equal(result.ok, true)
  assert.equal(result.filter.selfApplied, true)
  assert.equal(result.filter.unfinishedApplied, false)
  assert.equal(result.filter.dateActive, false)
  assert.equal(result.filter.warnings.length, 2)
})

test('task number searches keep dashboard filters and reject summary-only and partial matches', async (t) => {
  const supportProjectId = '102'
  const exact = { ...issue, issueNum: 'support-team-24' }
  const similar = { ...issue, issueId: 'other', issueNum: 'support-team-241', summary: '跟进 support-team-24' }
  t.mock.method(ChoerodonClient.prototype, 'self', async () => ({ id: 'me' }))
  t.mock.method(ChoerodonClient.prototype, 'fieldDefs', async () => [{ code: 'technicalOwner', id: 'owner-field' }])
  t.mock.method(ChoerodonClient.prototype, 'unfinishedStatusIds', async () => ['status-fixture'])
  let matchingRow = exact
  const workList = t.mock.method(ChoerodonClient.prototype, 'workList', async (project, { conditions }, page, size) => {
    assert.equal(project, supportProjectId)
    assert.deepEqual(conditions.map(({ field }) => field.fieldCode), ['technicalOwner', 'status', 'content', 'creationDate'])
    assert.equal(conditions[2].value.valueStr, 'support-team-24')
    assert.equal(size, 50)
    return {
      content: page === 0 ? Array.from({ length: size }, () => similar) : [matchingRow],
      totalElements: 51,
      totalPages: 2,
    }
  })
  const call = host()
  const query = `tasks?projectId=${supportProjectId}&keyword=SUPPORT-TEAM-24&since=2026-08-21&until=2026-11-21`
  const matched = await call(query)
  assert.deepEqual(matched.items.map(({ issueNum }) => issueNum), ['support-team-24'])
  assert.equal(matched.total, 1)
  assert.equal(matched.totalPages, 1)
  assert.deepEqual(workList.mock.calls.map(({ arguments: args }) => args[2]), [0, 1])

  matchingRow = similar
  const missing = await call(query)
  assert.deepEqual(missing.items, [])
  assert.equal(missing.total, 0)
})

test('exact lookup bypasses dashboard filters, and details load without auxiliary calls', async (t) => {
  t.mock.method(ChoerodonClient.prototype, 'workList', async (project, { conditions }) => {
    assert.equal(project, projectId)
    assert.deepEqual(conditions.map(({ field }) => field.fieldCode), ['content'])
    return { content: [{ ...issue, issueNum: 'OPS-1234' }, issue] }
  })
  t.mock.method(ChoerodonClient.prototype, 'issueDetail', async () => issue)
  const decrypt = t.mock.method(ChoerodonClient.prototype, 'decryptIssueId', async () => '999')
  const transforms = t.mock.method(ChoerodonClient.prototype, 'transforms', async (_project, { statusId }) => {
    assert.equal(statusId, 'status-fixture')
    return [{ id: 'transition-fixture' }]
  })
  const call = host()
  const lookup = await call('lookup?issueNum=ops-123')
  assert.equal(lookup.issue.issueNum, issue.issueNum)
  const query = `projectId=${projectId}&issueId=${issueId}`
  assert.equal((await call(`issue?${query}`)).issue.issueId, issueId)
  assert.equal(decrypt.mock.callCount(), 0)
  assert.equal(transforms.mock.callCount(), 0)
  assert.match((await call(`issue/link?${query}&issueNum=${issue.issueNum}`)).consoleUrl, /paramIssueId=999/)
  const choices = await call(`transforms?${query}`)
  assert.equal(choices.objectVersionNumber, 7)
  assert.equal(choices.transforms[0].id, 'transition-fixture')
})

test('dispatch uses one first comment page and adds a handoff only once', async (t) => {
  t.mock.method(ChoerodonClient.prototype, 'issueDetail', async () => issue)
  t.mock.method(ChoerodonClient.prototype, 'decryptIssueId', async () => '999')
  const comments = t.mock.method(ChoerodonClient.prototype, 'comments', async (_project, _issue, page, size) => {
    assert.equal(page, 0)
    assert.equal(size, 50)
    return { items: [comment, { text: '普通评论内容' }], total: 2 }
  })
  const result = await host()('dispatch', { projectId, issueId, kind: 'design' })
  assert.equal(result.ok, true)
  assert.equal(comments.mock.callCount(), 1)
  assert.equal(result.prompt.split('已经补齐离线测试材料').length, 2)
  assert.match(result.prompt, /普通评论内容/)
  assert.equal(result.context.handoffCount, 1)
  assert.equal(result.context.commentsIncluded, 1)
})

test('handoff read-back needs the new comment or authoritative evidence about it', async (t) => {
  const self = { loginName: comment.loginName }
  const target = { projectId, issueId, text: comment.text }
  let rows = [comment]
  t.mock.method(ChoerodonClient.prototype, 'self', async () => self)
  t.mock.method(ChoerodonClient.prototype, 'comments', async () => ({ items: rows }))
  const create = t.mock.method(ChoerodonClient.prototype, 'addComment', async () => ({ commentId: 'new-comment' }))
  const call = host()
  const pending = await call('handoff', target)
  assert.equal(pending.verified, false)
  assert.ok(pending.receipt)
  const now = new Date().toISOString()
  rows = [{ ...comment, commentId: 'different-comment', creationDate: now }, comment]
  assert.equal((await call('handoff/verify', { ...target, receipt: pending.receipt })).verified, false)
  rows = [{ ...comment, commentId: 'new-comment', creationDate: now }, comment]
  const verify = await call('handoff/verify', { ...target, receipt: pending.receipt })
  assert.equal(verify.verified, true)
  assert.equal(verify.handoff.commentId, 'new-comment')
  assert.equal((await call('handoff/verify', { ...target, issueId: 'other', receipt: pending.receipt })).verified, false)
  assert.equal(create.mock.callCount(), 1)

  create.mock.mockImplementation(async () => null)
  const withoutId = await call('handoff', target)
  assert.equal(withoutId.verified, false)
  rows = [{ ...comment, commentId: 'next-comment', creationDate: new Date().toISOString() }, ...rows]
  assert.equal((await call('handoff/verify', { ...target, receipt: withoutId.receipt })).handoff.commentId, 'next-comment')
})

test('connection check uses a new login with the candidate password and does not save it', async (t) => {
  const seen = []
  t.mock.method(ChoerodonClient.prototype, 'login', async ({ password }) => {
    seen.push(password)
    return 'fixture-only-token'
  })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/self')) return Response.json({ id: 'fixture-user' })
    if (pathname.endsWith('/star_projects')) return Response.json([])
    assert.fail(`unexpected mock request: ${pathname}`)
  })
  const call = host()
  assert.equal((await call('test', { password: 'candidate', settings: { projects: [] } })).ok, true)
  assert.equal((await call('test', { settings: { projects: [] } })).ok, true)
  assert.equal((await call('test', { settings: { baseUrl: 'https://other-fixture.invalid' } })).ok, false)
  assert.deepEqual(seen, ['candidate', 'fixture-only-password'])
})

test('a stale login cannot populate the cache for new credentials', async (t) => {
  let config = await settings.load()
  const client = new ChoerodonClient(() => config)
  let finishOldLogin
  const login = t.mock.method(client, 'login', ({ password }) => {
    if (password === 'next-fixture') return Promise.resolve('next-token')
    return new Promise((resolve) => { finishOldLogin = resolve })
  })
  const stale = assert.rejects(client.token(), /连接配置已变更/)
  config = { ...config, password: 'next-fixture' }
  assert.equal(await client.token(), 'next-token')
  finishOldLogin('stale-token')
  await stale
  assert.equal(await client.token(), 'next-token')
  assert.equal(login.mock.callCount(), 2)
})

test('image proxy uses the vetted address and shares an HTTPS preview until settings are cleared', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const target = 'https://wdcdn.qpic.cn/fixture.png?signature=fixture-secret'
  let requests = 0
  const proxy = createImageProxy({
    store: settings,
    client: { token: async () => assert.fail('Public preview should be anonymous') },
    imageToken: 'fixture-image-token',
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    requestHttps(url, options, onResponse) {
      assert.equal(url.href, target)
      assert.equal(options.headers.authorization, undefined)
      options.lookup(url.hostname, {}, (_error, address) => assert.equal(address, '93.184.216.34'))
      requests += 1
      const outgoing = new EventEmitter()
      outgoing.end = () => {
        const response = Readable.from([png])
        response.statusCode = 200
        response.headers = {}
        onResponse(response)
      }
      return outgoing
    },
  })
  const call = (source) => {
    const query = new URLSearchParams({ t: 'fixture-image-token', url: source })
    return proxy.handle(new Request(`http://fixture.invalid/plugin/choerodon/image?${query}`))
  }
  const response = await call(target)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  assert.equal((await call('https://unconfigured.invalid/fixture.png')).headers.get('x-choerodon-image-error'), 'blocked')
  await call(target)
  assert.equal(requests, 1)
  proxy.clear()
  await call(target)
  assert.equal(requests, 2)
  const logPath = path.join(home, 'choerodon-workbench', 'image.log')
  let log = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    log = await fs.readFile(logPath, 'utf8').catch(() => '')
    if (log.split('\n').length === 4) break
    await delay(25)
  }
  assert.equal(log.split('\n').length, 4)
  assert.match(log, /"host":"wdcdn.qpic.cn"/)
  assert.doesNotMatch(log, /fixture-secret|signature=|\/fixture\.png/)
})
