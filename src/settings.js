import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Harness home, matching the credentials provider's default. */
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const SETTINGS_DIR = path.join(HOME, 'choerodon-workbench')
export const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')

/**
 * Neutral defaults: installation-specific values (gateway, account, projects,
 * console URL, session directory) are configured by each user, not shipped.
 */
export const DEFAULT_SETTINGS = {
  baseUrl: '',
  username: '',
  password: '',
  organizationId: '1',
  tenantId: '1',
  pageSize: 20,
  sessionRoot: '',
  dispatchMode: 'draft',
  agentPreset: '',
  unfinishedTypes: ['todo', 'doing'],
  defaultProjectId: '',
  detailUrlTemplate: '',
  projects: [],
}

const SECRET_FIELDS = new Set(['password'])

/** Strip the password when a settings object leaves the Host. */
export function maskedSettings(settings) {
  const copy = { ...settings }
  copy.password = ''
  copy.hasPassword = Boolean(settings.password)
  return copy
}

function mergeSettings(base, patch) {
  const next = { ...base, ...(patch || {}) }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (next[key] === undefined || next[key] === null) next[key] = DEFAULT_SETTINGS[key]
  }
  if (!Array.isArray(next.projects)) next.projects = []
  if (!Array.isArray(next.unfinishedTypes) || next.unfinishedTypes.length === 0) {
    next.unfinishedTypes = DEFAULT_SETTINGS.unfinishedTypes
  }
  return next
}

export function createSettingsStore() {
  let cache = null
  let loading = null

  async function read() {
    let raw
    try {
      raw = await fs.readFile(SETTINGS_FILE, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return mergeSettings(DEFAULT_SETTINGS, {})
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return mergeSettings(DEFAULT_SETTINGS, {})
    }
    return mergeSettings(DEFAULT_SETTINGS, parsed)
  }

  async function load(force = false) {
    if (force) cache = null
    if (cache) return cache
    if (!loading) {
      loading = read()
        .then((value) => {
          cache = value
          return value
        })
        .finally(() => {
          loading = null
        })
    }
    return loading
  }

  function get() {
    if (cache) return cache
    throw new Error('设置尚未加载')
  }

  async function save(patch) {
    const current = await load()
    const next = mergeSettings(current, patch)
    for (const field of SECRET_FIELDS) {
      const incoming = patch && patch[field]
      if (typeof incoming !== 'string' || incoming.length === 0) next[field] = current[field] || ''
    }
    if (next.pageSize < 1 || next.pageSize > 200) next.pageSize = 20
    await fs.mkdir(SETTINGS_DIR, { recursive: true })
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
    await fs.chmod(SETTINGS_FILE, 0o600).catch(() => {})
    cache = next
    return next
  }

  return { load, get, save, file: SETTINGS_FILE }
}
