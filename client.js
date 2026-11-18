window.__ModuleLoader__.load({
  id: 'dsh-choerodon-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/choerodon'
    let pluginCtx = null

    // ------------------------------------------------------------ utilities

    function service(name) {
      try {
        if (!pluginCtx || typeof pluginCtx.get !== 'function') return null
        return pluginCtx.get(name) || null
      } catch (error) {
        return null
      }
    }

    function errorText(error) {
      return error && error.message ? error.message : String(error)
    }

    async function requestJson(pathname, params, init) {
      const url = new URL(API + pathname, window.location.origin)
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === '') continue
          url.searchParams.set(key, String(value))
        }
      }
      let response
      try {
        response = await fetch(url.toString(), {
          cache: 'no-store',
          credentials: 'same-origin',
          ...init,
          headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
        })
      } catch (error) {
        throw new Error(`本机插件接口连接失败：${errorText(error)}。请检查插件是否启用后重试。`)
      }
      let data = null
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(`猪齿鱼插件后端返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!data || data.ok !== true) {
        const message = response.status === 401
          ? '猪齿鱼会话无效或已过期，请在设置中重新测试连接。'
          : response.status === 403
            ? '当前猪齿鱼账号无权执行此操作，请检查项目权限。'
            : response.status >= 500
              ? `猪齿鱼服务暂时异常（HTTP ${response.status}），请稍后重试。`
              : (data && data.error) || `请求失败（HTTP ${response.status}）`
        throw new Error(message)
      }
      return data
    }

    const apiGet = (pathname, params) => requestJson(pathname, params)
    const apiPost = (pathname, body) =>
      requestJson(pathname, null, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => {})
        }
      } catch (error) {
        /* clipboard is optional */
      }
    }

    function formatTime(value) {
      const text = String(value || '')
      if (!text) return ''
      const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text)
      if (!match) return text
      const then = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`)
      const diff = Date.now() - then.getTime()
      if (!Number.isFinite(diff) || diff < 0) return `${match[1]}-${match[2]}-${match[3]}`
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      if (days < 30) return `${days} 天前`
      return `${match[1]}-${match[2]}-${match[3]}`
    }

    // ------------------------------------------------- creation-date range

    const RANGE_KEY = 'choerodon-workbench:date-range'
    const PROJECT_PREFS_KEY = 'choerodon-workbench:project-preferences:v1'
    const SELECTED_PROJECT_KEY = 'choerodon-workbench:selected-project'
    const DEFAULT_SORT = 'lastUpdateDate,desc'
    const DISPATCH_LABELS = { fix: '数据修复', bug: 'Bug 排查', dev: '需求开发', design: '需求评审' }
    const HANDOFF_ROLES = { product: '产品评审', engineering: '研发提测', testing: '测试结论', operations: '运维排障与上线验证' }
    const HANDOFF_ROLE_KEY = 'choerodon-workbench:handoff-role:v1'
    const SORT_OPTIONS = [
      { value: 'lastUpdateDate,desc', label: '最近更新' },
      { value: 'lastUpdateDate,asc', label: '最久未更新' },
      { value: 'creationDate,desc', label: '最新创建' },
      { value: 'creationDate,asc', label: '最早创建' },
    ]
    const RANGE_PRESETS = [
      { value: 'm1', label: '近 1 个月', months: 1 },
      { value: 'm3', label: '近 3 个月', months: 3 },
      { value: 'm6', label: '近 6 个月', months: 6 },
      { value: 'm12', label: '近 1 年', months: 12 },
      { value: 'all', label: '全部时间', months: 0 },
      { value: 'custom', label: '自定义', months: null },
    ]

    function fmtDate(date) {
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Subtract calendar months, clamping month-end overflow (May 31 - 3m => Feb 28). */
    function monthsAgo(months) {
      const now = new Date()
      const wantedMonth = ((now.getMonth() - months) % 12 + 12) % 12
      const result = new Date(now.getFullYear(), now.getMonth() - months, now.getDate())
      if (result.getMonth() !== wantedMonth) result.setDate(0)
      return result
    }

    function presetRange(months) {
      if (!months || months <= 0) return { since: '', until: '', preset: 'all' }
      return { since: fmtDate(monthsAgo(months)), until: fmtDate(new Date()), preset: `m${months}` }
    }

    function defaultRange(months) {
      const value = Number(months)
      return presetRange(Number.isFinite(value) && value >= 0 && value <= 120 ? value : 3)
    }

    function readSavedRange() {
      try {
        const raw = window.localStorage.getItem(RANGE_KEY)
        if (!raw) return null
        const saved = JSON.parse(raw)
        const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
        if (saved && typeof saved === 'object' && validDate(saved.since) && validDate(saved.until)) {
          return { since: saved.since, until: saved.until, preset: String(saved.preset || 'custom') }
        }
        if (saved && saved.preset === 'all') return { since: '', until: '', preset: 'all' }
      } catch (error) {
        /* localStorage may be unavailable */
      }
      return null
    }

    function readProjectPrefs(projectId) {
      if (!projectId) return null
      try {
        const all = JSON.parse(window.localStorage.getItem(PROJECT_PREFS_KEY) || '{}')
        const saved = all && all[String(projectId)]
        if (!saved || typeof saved !== 'object') return null
        const range = saved.range && typeof saved.range === 'object' ? saved.range : null
        if (range) {
          const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
          if (range.preset === 'all') saved.range = { since: '', until: '', preset: 'all' }
          else if (!validDate(range.since) || !validDate(range.until)) saved.range = null
        }
        return {
          selfOnly: typeof saved.selfOnly === 'boolean' ? saved.selfOnly : true,
          unfinished: typeof saved.unfinished === 'boolean' ? saved.unfinished : true,
          range: saved.range || null,
          sort: SORT_OPTIONS.some((item) => item.value === saved.sort) ? saved.sort : DEFAULT_SORT,
        }
      } catch (error) {
        return null
      }
    }

    function writeProjectPrefs(projectId, prefs) {
      if (!projectId) return
      try {
        const all = JSON.parse(window.localStorage.getItem(PROJECT_PREFS_KEY) || '{}')
        all[String(projectId)] = prefs
        window.localStorage.setItem(PROJECT_PREFS_KEY, JSON.stringify(all))
      } catch (error) {
        /* localStorage may be unavailable */
      }
    }

    function saveSelectedProject(projectId) {
      try {
        window.localStorage.setItem(SELECTED_PROJECT_KEY, String(projectId || ''))
      } catch (error) {
        /* localStorage may be unavailable */
      }
    }

    function readSelectedProject() {
      try {
        return window.localStorage.getItem(SELECTED_PROJECT_KEY) || ''
      } catch (error) {
        return ''
      }
    }

    function rangeLabel(range) {
      if (!range || range.preset === 'all' || !range.since) return '全部时间'
      return `${range.since} ~ ${range.until}`
    }

    // --------------------------------------------------------------- styles

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: C.bg,
        color: C.text,
        fontFamily: 'inherit',
        fontSize: 13,
      },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderBottom: `1px solid ${C.border}`,
        flexWrap: 'wrap',
      },
      filterBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 14px',
        borderBottom: `1px solid ${C.border}`,
        background: C.layer1,
        flexWrap: 'wrap',
        fontSize: 12,
        color: C.sub,
      },
      dateInput: {
        height: 26,
        padding: '0 6px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.bg,
        color: C.text,
        fontSize: 11,
        fontFamily: 'inherit',
        colorScheme: 'inherit',
      },
      input: {
        height: 28,
        padding: '0 8px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.layer1,
        color: C.text,
        fontSize: 12,
        fontFamily: 'inherit',
        colorScheme: 'inherit',
        outline: 'none',
      },
      button: {
        height: 28,
        padding: '0 10px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.layer1,
        color: C.text,
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        height: 28,
        padding: '0 12px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: C.brand,
        color: '#fff',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonTiny: {
        height: 22,
        padding: '0 8px',
        borderRadius: 5,
        border: `1px solid ${C.border}`,
        background: C.layer2,
        color: C.sub,
        fontSize: 11,
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      listPane: { flex: 1, minWidth: 0, overflow: 'auto', padding: '8px 8px 16px' },
      detailPane: {
        width: 400,
        flex: '0 0 400px',
        borderLeft: `1px solid ${C.border}`,
        overflow: 'auto',
        padding: '12px 14px 24px',
        background: C.layer1,
      },
      row: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '9px 10px',
        borderRadius: 8,
        border: `1px solid transparent`,
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'inherit',
        cursor: 'pointer',
        marginBottom: 2,
      },
      rowActive: { background: C.layer2, border: `1px solid ${C.border2}` },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 },
      num: { fontVariantNumeric: 'tabular-nums', fontSize: 12, color: C.brand, fontWeight: 600 },
      badge: {
        fontSize: 10,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 4,
        background: C.layer2,
        color: C.sub,
        whiteSpace: 'nowrap',
      },
      summary: { fontSize: 12.5, lineHeight: '18px', color: C.text, overflow: 'hidden' },
      meta: { fontSize: 11, color: C.sub, marginTop: 3 },
      empty: { padding: '48px 24px', textAlign: 'center', color: C.sub, fontSize: 12 },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        borderTop: `1px solid ${C.border}`,
        fontSize: 12,
        color: C.sub,
      },
      label: { fontSize: 11, color: C.sub, marginBottom: 3, display: 'block' },
      field: { marginBottom: 12 },
      notice: (tone) => ({
        padding: '7px 10px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: '17px',
        marginBottom: 10,
        background: C.layer2,
        border: `1px solid ${tone === 'error' ? C.error : tone === 'warn' ? C.warn : C.border}`,
        color: C.text,
      }),
      sectionTitle: {
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: C.sub,
        margin: '16px 0 8px',
      },
      card: {
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        background: C.bg,
        marginBottom: 10,
      },
      comment: { borderTop: `1px solid ${C.border}`, padding: '8px 0' },
      textarea: {
        width: '100%',
        minHeight: 64,
        padding: 8,
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.bg,
        color: C.text,
        fontSize: 12,
        fontFamily: 'inherit',
        resize: 'vertical',
        boxSizing: 'border-box',
        colorScheme: 'inherit',
      },
    }

    // Rich-text styles for issue descriptions and comments. Tokens only, so the
    // fragment follows the host theme in light and dark mode.
    const PROSE_CSS = [
      '.cw-prose{font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word;}',
      '.cw-prose>:first-child{margin-top:0;}',
      '.cw-prose p{margin:0 0 8px;}',
      '.cw-prose h1,.cw-prose h2,.cw-prose h3,.cw-prose h4,.cw-prose h5,.cw-prose h6{margin:12px 0 6px;font-weight:600;line-height:1.35;}',
      '.cw-prose h1{font-size:16px;}', '.cw-prose h2{font-size:15px;}', '.cw-prose h3,.cw-prose h4,.cw-prose h5,.cw-prose h6{font-size:13px;}',
      '.cw-prose ul,.cw-prose ol{margin:0 0 8px;padding-left:20px;}',
      '.cw-prose li{margin:2px 0;}',
      '.cw-prose a{color:var(--dsw-alias-brand-primary);text-decoration:none;}',
      '.cw-prose a:hover{text-decoration:underline;}',
      '.cw-prose img{max-width:100%;height:auto;display:block;margin:6px 0;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);cursor:zoom-in;background:var(--dsw-alias-bg-layer-2);}',
      '.cw-prose figure{margin:6px 0;}',
      '.cw-prose figcaption{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:2px;}',
      '.cw-prose code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px;}',
      '.cw-prose pre{background:var(--dsw-alias-bg-layer-2);padding:8px 10px;border-radius:6px;overflow:auto;margin:0 0 8px;}',
      '.cw-prose pre code{background:transparent;padding:0;}',
      '.cw-prose blockquote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.cw-prose table{border-collapse:collapse;margin:6px 0;font-size:11px;}',
      '.cw-prose th,.cw-prose td{border:1px solid var(--dsw-alias-border-l1);padding:3px 6px;vertical-align:top;}',
      '.cw-prose hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0;}',
      '.cw-img-error{display:inline-block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;margin:4px 0;}',
    ].join('\n')

    // Rich text payloads render through the browser, but their screenshots are
    // fetched as blobs: an <img> request and a fetch differ in admission, and a
    // failed fetch can report its HTTP status instead of a broken image icon.
    const resolvedImages = new Map()

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function resolveImage(src) {
      if (!resolvedImages.has(src)) {
        resolvedImages.set(
          src,
          (async () => {
            try {
              const response = await fetch(src, { credentials: 'same-origin', cache: 'force-cache' })
              if (!response.ok) return { error: `HTTP ${response.status}` }
              const type = response.headers.get('content-type') || ''
              if (!/^image\//i.test(type)) return { error: type || '返回的不是图片' }
              return { url: URL.createObjectURL(await response.blob()) }
            } catch (error) {
              return { error: errorText(error) }
            }
          })(),
        )
      }
      return resolvedImages.get(src)
    }

    function useRichHtml(html) {
      const [rendered, setRendered] = React.useState(html || '')
      React.useEffect(() => {
        let cancelled = false
        if (!html) {
          setRendered('')
          return undefined
        }
        const tags = Array.from(html.matchAll(/<img\b[^>]*>/gi), (match) => match[0])
        if (tags.length === 0) {
          setRendered(html)
          return undefined
        }
        setRendered(html)
        Promise.all(
          tags.map(async (tag) => {
            const source = /src="([^"]*)"/i.exec(tag)
            if (!source) return { tag, replacement: '<span class="cw-img-error">图片缺少地址</span>' }
            const result = await resolveImage(source[1].replace(/&amp;/g, '&'))
            if (result.url) {
              return { tag, replacement: tag.replace(/src="[^"]*"/i, `src="${result.url}"`) }
            }
            return {
              tag,
              replacement: `<span class="cw-img-error">图片加载失败（${escapeHtml(result.error)}）</span>`,
            }
          }),
        )
          .then((items) => {
            if (cancelled) return
            let next = html
            for (const item of items) next = next.split(item.tag).join(item.replacement)
            setRendered(next)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [html])
      return rendered
    }

    function CommentBody(props) {
      const html = useRichHtml(props.html || '')
      if (!html) {
        return h('div', { style: { fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, props.text || '')
      }
      return h('div', {
        className: 'cw-prose',
        onClick: props.onImageClick,
        dangerouslySetInnerHTML: { __html: html },
      })
    }

    // --------------------------------------------------------------- pieces

    function StatusBadge(props) {
      const type = props.type || ''
      const tone = type === 'done' ? C.idle : type === 'doing' ? C.warn : C.brand
      return h(
        'span',
        { style: { ...styles.badge, color: tone, border: `1px solid ${C.border}` } },
        props.name || '—',
      )
    }

    function Toggle(props) {
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 12,
            color: props.checked ? C.text : C.sub,
            cursor: 'pointer',
            userSelect: 'none',
          },
        },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: (event) => props.onChange(event.target.checked),
          style: { accentColor: C.brand, margin: 0 },
        }),
        props.label,
      )
    }

    function Notice(props) {
      const notice = props.notice
      if (!notice) return null
      return h('div', { style: { ...styles.notice(notice.tone), display: 'flex', alignItems: 'center', gap: 10 } },
        h('span', { style: { flex: 1, minWidth: 0 } }, notice.text),
        notice.path
          ? h('button', { type: 'button', style: styles.buttonTiny, onClick: () => copyText(notice.path) }, '复制会话路径')
          : null,
        notice.sticky
          ? h('button', { type: 'button', style: styles.buttonTiny, onClick: props.onDismiss, 'aria-label': '关闭提示' }, '关闭')
          : null,
      )
    }

    // ---------------------------------------------------------- dispatch glue

    async function startDispatch(payload) {
      const workspaces = service('workspaces')
      const uiWorkspace = service('uiWorkspace')
      let workspaceId = undefined
      if (workspaces && typeof workspaces.create === 'function') {
        const created = await workspaces.create({ path: payload.dir })
        workspaceId =
          created && created.workspace ? created.workspace.workspaceId : created ? created.workspaceId : undefined
      }
      if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
        uiWorkspace.startSession(workspaceId, { prompt: payload.prompt, whenDraftExists: 'replace' })
        return {
          tone: 'ok',
          text: `已为 ${payload.title} 创建会话草稿。请在会话中检查内容，确认后按回车开始。`,
          path: payload.dir,
        }
      }
      throw new Error('会话服务不可用，无法新建会话')
    }

    // ------------------------------------------------------------ main panel

    function Panel() {
      const [boot, setBoot] = React.useState(null)
      const [bootError, setBootError] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [projectId, setProjectId] = React.useState('')
      const [list, setList] = React.useState({ items: [], total: 0, totalPages: 1, page: 0, size: 20, filter: null })
      const [page, setPage] = React.useState(0)
      const [keyword, setKeyword] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [selfOnly, setSelfOnly] = React.useState(true)
      const [unfinished, setUnfinished] = React.useState(true)
      const [loading, setLoading] = React.useState(false)
      const [listError, setListError] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const [selectedId, setSelectedId] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [detailState, setDetailState] = React.useState('idle')
      const [detailError, setDetailError] = React.useState('')
      const [tab, setTab] = React.useState('detail')
      const [comments, setComments] = React.useState(null)
      const [handoffData, setHandoffData] = React.useState(null)
      const [handoffReload, setHandoffReload] = React.useState(0)
      const [handoffRole, setHandoffRole] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem(HANDOFF_ROLE_KEY)
          return Object.hasOwn(HANDOFF_ROLES, saved) ? saved : 'product'
        } catch (error) {
          return 'product'
        }
      })
      const [handoffDraft, setHandoffDraft] = React.useState('')
      const [handoffUncertain, setHandoffUncertain] = React.useState(false)
      const [commentDraft, setCommentDraft] = React.useState('')
      const [pendingTransform, setPendingTransform] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [dispatchOpen, setDispatchOpen] = React.useState(false)
      const [previewSrc, setPreviewSrc] = React.useState('')
      // null until the boot response supplies the configured default lookback.
      const [range, setRange] = React.useState(null)
      const [rangeQuery, setRangeQuery] = React.useState(null)
      const [sort, setSort] = React.useState(DEFAULT_SORT)
      const [prefsReady, setPrefsReady] = React.useState(false)
      const [bootTick, setBootTick] = React.useState(0)
      const [listUpdatedAt, setListUpdatedAt] = React.useState(0)
      const [dispatchPayload, setDispatchPayload] = React.useState(null)
      const [dispatchDraft, setDispatchDraft] = React.useState('')
      const [dispatchKind, setDispatchKind] = React.useState('bug')

      const settings = boot && boot.settings ? boot.settings : null
      const ready = Boolean(boot && boot.ready)
      const descriptionHtml = useRichHtml(detail && detail.issue ? detail.issue.descriptionHtml : '')

      React.useEffect(() => {
        let cancelled = false
        Promise.all([apiGet('/state'), apiGet('/projects')])
          .then(([state, projectData]) => {
            if (cancelled) return
            setBoot(state)
            const watched = projectData.projects || []
            setProjects(watched)
            const preferred = readSelectedProject() || projectData.defaultProjectId || ''
            const first = watched.find((item) => item.projectId === preferred) || watched[0]
            if (first) {
              setProjectId(first.projectId)
              saveSelectedProject(first.projectId)
              const saved = readProjectPrefs(first.projectId)
              setSelfOnly(saved ? saved.selfOnly : true)
              setUnfinished(saved ? saved.unfinished : true)
              setRange((saved && saved.range) || readSavedRange() || defaultRange(state.settings?.defaultLookbackMonths))
              setSort(saved ? saved.sort : DEFAULT_SORT)
            } else {
              setRange(defaultRange(state.settings?.defaultLookbackMonths))
            }
            setPrefsReady(true)
          })
          .catch((error) => {
            if (!cancelled) setBootError(errorText(error))
          })
        return () => {
          cancelled = true
        }
      }, [bootTick])

      React.useEffect(() => {
        if (!notice || notice.sticky) return undefined
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      React.useEffect(() => {
        if (!prefsReady || !projectId) return
        writeProjectPrefs(projectId, { selfOnly, unfinished, range, sort })
        saveSelectedProject(projectId)
      }, [prefsReady, projectId, selfOnly, unfinished, range, sort])

      React.useEffect(() => {
        if (!previewSrc) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPreviewSrc('')
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [previewSrc])

      function openImagePreview(event) {
        const target = event && event.target
        if (target && target.tagName === 'IMG') {
          const src = target.getAttribute('src')
          if (src) setPreviewSrc(src)
        }
      }

      React.useEffect(() => {
        const timer = setTimeout(() => setQuery(keyword.trim()), 300)
        return () => clearTimeout(timer)
      }, [keyword])

      // Date inputs can fire several changes in a row; debounce the query too.
      React.useEffect(() => {
        if (!range) return undefined
        const timer = setTimeout(() => setRangeQuery(range), 250)
        return () => clearTimeout(timer)
      }, [range])

      React.useEffect(() => {
        setPage(0)
      }, [projectId, query, selfOnly, unfinished, range, sort])

      React.useEffect(() => {
        if (!ready || !projectId || !rangeQuery) return undefined
        let cancelled = false
        setLoading(true)
        setListError('')
        apiGet('/tasks', {
          projectId,
          page,
          size: list.size || 20,
          keyword: query,
          selfOnly: selfOnly ? 1 : 0,
          unfinished: unfinished ? 1 : 0,
          since: rangeQuery.since,
          until: rangeQuery.until,
          sort,
        })
          .then((data) => {
            if (cancelled) return
            setList(data)
            setListUpdatedAt(Date.now())
            setLoading(false)
          })
          .catch((error) => {
            if (cancelled) return
            setListError(errorText(error))
            setLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [ready, projectId, page, query, selfOnly, unfinished, rangeQuery, sort, tick])

      const selected = React.useMemo(
        () => list.items.find((item) => item.issueId === selectedId) || null,
        [list.items, selectedId],
      )

      React.useEffect(() => {
        if (!selected || !projectId) return undefined
        let cancelled = false
        setDetail(null)
        setDetailState('loading')
        setDetailError('')
        setComments(null)
        setTab('detail')
        setPendingTransform(null)
        Promise.all([
          apiGet('/issue', { projectId, issueId: selected.issueId }),
          apiGet('/comments', { projectId, issueId: selected.issueId, page: 0, size: 20 }).catch((error) => ({
            ok: false,
            error: errorText(error),
            items: [],
            total: 0,
          })),
        ])
          .then(([issueData, commentData]) => {
            if (cancelled) return
            setDetail(issueData)
            setComments(commentData)
            setDetailState('ready')
          })
          .catch((error) => {
            if (cancelled) return
            setDetailError(errorText(error))
            setDetailState('error')
          })
        return () => {
          cancelled = true
        }
      }, [selected, projectId, tick])

      React.useEffect(() => {
        if (tab !== 'handoffs' || !detail || !detail.issue || !projectId) return undefined
        let cancelled = false
        setHandoffData({ loading: true, items: [], totalComments: 0, scannedComments: 0, truncated: false })
        apiGet('/handoffs', { projectId, issueId: detail.issue.issueId })
          .then((result) => {
            if (!cancelled) setHandoffData(result)
          })
          .catch((error) => {
            if (!cancelled) setHandoffData({ ok: false, error: errorText(error), items: [] })
          })
        return () => {
          cancelled = true
        }
      }, [tab, selectedId, projectId, tick, handoffReload])

      function refreshDetail() {
        setTick((value) => value + 1)
      }

      async function changeStatus(transform) {
        if (!detail || !transform) return
        setBusy('status')
        try {
          await apiPost('/status', {
            projectId,
            issueId: detail.issue.issueId,
            transformId: transform.id,
            objectVersionNumber: detail.issue.objectVersionNumber,
          })
          setNotice({ tone: 'ok', text: `状态已改为「${transform.targetStatusName}」` })
          setPendingTransform(null)
          refreshDetail()
        } catch (error) {
          setNotice({ tone: 'error', text: `改状态失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      async function submitComment() {
        const text = commentDraft.trim()
        if (!text || !detail) return
        setBusy('comment')
        try {
          await apiPost('/comment', { action: 'add', projectId, issueId: detail.issue.issueId, text })
          setCommentDraft('')
          setNotice({ tone: 'ok', text: '评论已发送' })
          refreshDetail()
        } catch (error) {
          setNotice({ tone: 'error', text: `发评论失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      async function removeComment(item) {
        if (!detail) return
        if (!window.confirm('删除这条评论？')) return
        setBusy('comment')
        try {
          await apiPost('/comment', { action: 'delete', projectId, commentId: item.commentId })
          setNotice({ tone: 'ok', text: '评论已删除' })
          refreshDetail()
        } catch (error) {
          setNotice({ tone: 'error', text: `删除失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      function chooseHandoffRole(role) {
        if (!Object.hasOwn(HANDOFF_ROLES, role) || role === handoffRole) return
        if (handoffUncertain) {
          setNotice({ tone: 'warn', text: '请先核实上次交接是否已发布，再切换角色或编辑草稿。' })
          return
        }
        if (handoffDraft.trim()) {
          setHandoffDraft('')
          setNotice({ tone: 'warn', text: '角色已切换，已清空上一角色的草稿；请重新生成模板。' })
        }
        setHandoffRole(role)
        try {
          window.localStorage.setItem(HANDOFF_ROLE_KEY, role)
        } catch (error) {
          /* localStorage may be unavailable */
        }
      }

      async function prepareHandoff() {
        if (!detail || !detail.issue || handoffUncertain) return
        setBusy('handoff-template')
        try {
          const result = await apiPost('/handoff/template', {
            projectId,
            issueId: detail.issue.issueId,
            role: handoffRole,
          })
          setHandoffDraft(result.text || '')
          setNotice({ tone: 'ok', text: `${result.title || HANDOFF_ROLES[handoffRole]}模板已生成，可编辑后发布` })
        } catch (error) {
          setNotice({ tone: 'error', text: `生成交接模板失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      async function publishHandoff() {
        const text = handoffDraft.trim()
        const expectedHeader = `【阶段交接 v1｜${HANDOFF_ROLES[handoffRole]}】`
        if (!detail || !detail.issue || !text || handoffUncertain) return
        if (!text.startsWith(expectedHeader)) {
          setNotice({ tone: 'error', text: `交接草稿角色与当前所选「${HANDOFF_ROLES[handoffRole]}」不匹配。请重新生成模板后再发布。` })
          return
        }
        setBusy('handoff-publish')
        setHandoffUncertain(true)
        try {
          const result = await apiPost('/handoff', { projectId, issueId: detail.issue.issueId, text })
          if (result.verified) {
            setHandoffUncertain(false)
            setNotice({ tone: 'ok', text: result.message || '交接记录已发布并回读核实' })
            if (result.handoff) {
              setHandoffData((current) => ({
                ...(current || {}),
                ok: true,
                items: [result.handoff, ...((current && current.items) || []).filter((item) => item.commentId !== result.handoff.commentId)],
              }))
            }
          } else {
            setNotice({ tone: 'warn', text: result.message || '发布结果尚未核实；请检查猪齿鱼后再决定是否允许重试。' })
          }
        } catch (error) {
          setNotice({ tone: 'error', text: `发布结果不确定：${errorText(error)}。请先检查猪齿鱼，避免重复提交。` })
        } finally {
          setBusy('')
        }
      }

      function releaseHandoffRetry() {
        if (!window.confirm('请先在猪齿鱼确认这条交接记录没有发布。确认后才会允许再次提交。')) return
        setHandoffUncertain(false)
        setNotice({ tone: 'warn', text: '已解除重复提交保护；发布前请再次确认评论中没有这条交接内容。' })
      }

      function applyRange(next) {
        setRange(next)
      }

      function switchProject(nextProjectId) {
        if (!nextProjectId || nextProjectId === projectId) return
        writeProjectPrefs(projectId, { selfOnly, unfinished, range, sort })
        saveSelectedProject(nextProjectId)
        const saved = readProjectPrefs(nextProjectId)
        setProjectId(nextProjectId)
        setSelfOnly(saved ? saved.selfOnly : true)
        setUnfinished(saved ? saved.unfinished : true)
        setRange((saved && saved.range) || defaultRange(settings?.defaultLookbackMonths))
        setSort(saved ? saved.sort : DEFAULT_SORT)
        setList({ items: [], total: 0, totalPages: 1, page: 0, size: list.size || 20, filter: null })
        setListError('')
        setListUpdatedAt(0)
        setSelectedId('')
        setDetail(null)
        setPage(0)
      }

      function clearProjectFilters() {
        const next = defaultRange(settings?.defaultLookbackMonths)
        setSelfOnly(true)
        setUnfinished(true)
        setKeyword('')
        setQuery('')
        setRange(next)
        setSort(DEFAULT_SORT)
        setPage(0)
      }

      function changePreset(value) {
        if (value === 'custom') {
          const base = range && range.since ? range : presetRange(3)
          applyRange({ ...base, preset: 'custom' })
          return
        }
        const preset = RANGE_PRESETS.find((item) => item.value === value)
        if (preset) applyRange(presetRange(preset.months))
      }

      function changeSince(value) {
        if (!range) return
        const until = range.until || fmtDate(new Date())
        applyRange({ since: value, until: value && value > until ? value : until, preset: 'custom' })
      }

      function changeUntil(value) {
        if (!range) return
        const since = range.since || fmtDate(monthsAgo(3))
        applyRange({ since: value && since > value ? value : since, until: value, preset: 'custom' })
      }

      async function prepareDispatch(kind) {
        if (!detail) return
        setDispatchOpen(false)
        setBusy('preview')
        try {
          const payload = await apiPost('/dispatch', { projectId, issueId: detail.issue.issueId, kind })
          setDispatchPayload(payload)
          setDispatchDraft(payload.prompt || '')
          setDispatchKind(kind)
        } catch (error) {
          setNotice({ tone: 'error', text: `准备草稿失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      async function confirmDispatch() {
        if (!dispatchPayload || !detail) return
        setBusy('dispatch')
        try {
          const directory = await apiPost('/dispatch/confirm', { projectId })
          const result = await startDispatch({ ...dispatchPayload, dir: directory.dir, prompt: dispatchDraft })
          setDispatchPayload(null)
          setNotice({ ...result, sticky: true })
        } catch (error) {
          setNotice({ tone: 'error', text: `创建会话失败：${errorText(error)}` })
        } finally {
          setBusy('')
        }
      }

      if (bootError) {
        return h('div', { style: styles.page }, h('div', { style: styles.empty },
          h('div', { style: { color: C.error, marginBottom: 8 } }, `插件后端不可用：${bootError}`),
          h('button', { type: 'button', style: styles.button, onClick: () => { setBootError(''); setBoot(null); setBootTick((v) => v + 1) } }, '重试连接')))
      }

      if (!boot) {
        return h('div', { style: styles.page }, h('div', { style: styles.empty }, '正在连接猪齿鱼…'))
      }

      if (!ready) {
        return h(
          'div',
          { style: styles.page },
          h('div', { style: styles.empty },
            h('div', { style: { fontSize: 14, color: C.text, marginBottom: 8 } }, '还没有配置猪齿鱼账号'),
            h('div', null, '打开侧栏底部的设置 →「猪齿鱼」，填写网关地址、用户名和密码后即可使用。'),
          ),
        )
      }

      if (projects.length === 0) {
        return h(
          'div',
          { style: styles.page },
          h(
            'div',
            { style: styles.empty },
            h('div', { style: { fontSize: 14, color: C.text, marginBottom: 8 } }, '还没有关注任何猪齿鱼项目'),
            h('div', null, '打开侧栏底部的设置 →「猪齿鱼」，搜索并添加你要关注的猪齿鱼项目。'),
          ),
        )
      }

      const project = projects.find((item) => item.projectId === projectId)
      const filterLabel = list.filter && list.filter.label ? list.filter.label : ''
      const showFilterHint = Boolean(selfOnly && filterLabel)

      return h(
        'div',
        { style: styles.page },
        h('style', { key: 'cw-prose-style' }, PROSE_CSS),
        h(
          'div',
          { style: styles.toolbar },
          h('select', {
            style: { ...styles.input, minWidth: 190 },
            value: projectId,
            onChange: (event) => switchProject(event.target.value),
            'aria-label': '选择项目',
          },
            projects.map((item) =>
              h('option', { key: item.projectId, value: item.projectId }, `${item.name} · ${item.code}`),
            ),
          ),
          h('input', {
            style: { ...styles.input, width: 220 },
            placeholder: '搜索工单号或概要',
            value: keyword,
            onChange: (event) => setKeyword(event.target.value),
            'aria-label': '搜索工单',
          }),
          h(Toggle, {
            label: showFilterHint ? `只看${filterLabel}=我` : '只看我',
            checked: selfOnly,
            onChange: setSelfOnly,
          }),
          h(Toggle, { label: '只看未完成', checked: unfinished, onChange: setUnfinished }),
          h('div', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => setTick((value) => value + 1),
            title: '刷新',
          }, '刷新'),
        ),
        h(Notice, { notice, onDismiss: () => setNotice(null) }),
        dateFilterBar(list, range, {
          onPreset: changePreset,
          onSince: changeSince,
          onUntil: changeUntil,
          sort,
          onSort: setSort,
          onClear: clearProjectFilters,
        }),
        h(
          'div',
          { style: styles.body },
          h(
            'div',
            { style: styles.listPane },
            loading && list.items.length === 0
              ? h('div', { style: styles.empty, role: 'status' }, '正在加载工单…')
              : null,
            loading && list.items.length > 0
              ? h('div', { style: { ...styles.notice('ok'), padding: '5px 9px', fontSize: 11 }, role: 'status' }, '正在刷新，暂时保留上次列表…')
              : null,
            listError
              ? h('div', { style: styles.notice('error'), role: 'alert' },
                  h('div', { style: { marginBottom: 6 } }, list.items.length > 0 ? `刷新失败，仍显示上次结果：${listError}` : listError),
                  h('button', { type: 'button', style: styles.button, onClick: () => setTick((v) => v + 1) }, '重试'))
              : null,
            !loading && !listError && list.filter && list.filter.warning
              ? h('div', { style: styles.notice('warn') }, '警告：自我过滤条件没有生效（返回条数等于全量），请到设置页检查「过滤字段」。')
              : null,
            !loading && !listError && list.items.length === 0
              ? h('div', { style: styles.empty },
                  query
                    ? '没有匹配的工单，换个关键词或放宽创建时间范围试试。'
                    : list.filter && list.filter.dateActive
                      ? '这个创建时间范围内没有符合条件的工单；可改成「全部时间」，或取消「只看未完成 / 只看我」。'
                      : '这个项目下没有符合条件的工单。',
                  list.filter && list.filter.dateActive
                    ? h('div', { style: { marginTop: 12 } },
                        h('button', { type: 'button', style: styles.button, onClick: () => changePreset('all') }, '查看全部时间'))
                    : null)
              : null,
            list.items.map((item) =>
              h(
                'button',
                {
                  key: item.issueId,
                  type: 'button',
                  style: selectedId === item.issueId ? { ...styles.row, ...styles.rowActive } : styles.row,
                  onClick: () => setSelectedId(item.issueId),
                },
                h('div', { style: styles.rowTop },
                  h('span', { style: styles.num }, item.issueNum),
                  h(StatusBadge, { name: item.statusName, type: item.statusType }),
                  h('span', { style: styles.badge }, item.parentId ? '子任务' : item.typeName || item.typeCode || '—'),
                  h('div', { style: { flex: 1 } }),
                  h('span', { style: { fontSize: 11, color: C.sub }, title: `更新时间：${item.lastUpdateDate || '未知'}` },
                    `更新于 ${formatTime(item.lastUpdateDate || item.creationDate) || '未知'}`),
                ),
                h('div', { style: styles.summary }, item.summary || '(无概要)'),
                h('div', { style: styles.meta },
                  `${item.assignee ? `经办人 ${item.assignee}` : '未指派'}${item.priority ? ` · 优先级 ${item.priority}` : ''}${item.creationDate ? ` · 创建 ${item.creationDate.slice(0, 10)}` : ''}`),
              ),
            ),
          ),
          h('div', { style: styles.detailPane }, renderDetail()),
        ),
        h(
          'div',
          { style: styles.footer },
          h('button', {
            type: 'button',
            style: styles.buttonTiny,
            disabled: page <= 0 || loading,
            onClick: () => setPage((value) => Math.max(0, value - 1)),
          }, '上一页'),
          h('span', null, `第 ${Math.min(page + 1, list.totalPages || 1)} / ${list.totalPages || 1} 页 · 共 ${list.total} 条`),
          h('button', {
            type: 'button',
            style: styles.buttonTiny,
            disabled: page + 1 >= (list.totalPages || 1) || loading,
            onClick: () => setPage((value) => value + 1),
          }, '下一页'),
          h('div', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11 }, title: listUpdatedAt ? `列表更新于 ${new Date(listUpdatedAt).toLocaleTimeString()}` : '' },
            listUpdatedAt ? `更新于 ${new Date(listUpdatedAt).toLocaleTimeString()}` : ''),
          h('span', { style: { fontSize: 11 } }, `每页 ${list.size || 20} 条`),
        ),
        previewSrc
          ? h(
              'div',
              {
                key: 'cw-image-preview',
                role: 'dialog',
                'aria-label': '图片预览',
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 999,
                  background: 'rgba(0,0,0,0.72)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  cursor: 'zoom-out',
                },
                onClick: () => setPreviewSrc(''),
              },
              h('img', {
                src: previewSrc,
                alt: '图片预览',
                style: {
                  maxWidth: '92vw',
                  maxHeight: '86vh',
                  display: 'block',
                  borderRadius: 8,
                  boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
                  background: '#fff',
                },
                onClick: (event) => event.stopPropagation(),
              }),
              h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 16,
                    textAlign: 'center',
                    color: '#fff',
                    fontSize: 11,
                    opacity: 0.85,
                  },
                },
                '点击空白处或按 Esc 关闭',
              ),
            )
          : null,
        dispatchPayload
          ? h('div', {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': dispatchKind === 'design' ? '需求评审预览' : '派发草稿预览',
              style: {
                position: 'fixed', inset: 0, zIndex: 1000,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 20, background: 'rgba(0,0,0,0.56)',
              },
            },
              h('div', { style: {
                width: 'min(760px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
                border: `1px solid ${C.border}`, borderRadius: 12, background: C.layer1,
                color: C.text, boxShadow: '0 18px 60px rgba(0,0,0,0.28)', overflow: 'hidden',
              } },
                h('div', { style: { padding: '14px 18px', borderBottom: `1px solid ${C.border}` } },
                  h('div', { style: { fontSize: 14, fontWeight: 650, marginBottom: 4 } }, dispatchKind === 'design' ? '需求评审预览' : `预览派发草稿 · ${DISPATCH_LABELS[dispatchKind] || '处理'}`),
                  h('div', { style: { fontSize: 11, color: C.sub } }, dispatchKind === 'design'
                    ? `${dispatchPayload.title || ''} · 先讨论设计，再整理开发说明和验收标准；不会自动修改工单`
                    : `${dispatchPayload.title || ''} · 可在下方编辑本次指令`),
                ),
                dispatchPayload.context
                  ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 18px 0', fontSize: 11, color: C.sub } },
                      h('span', { style: styles.badge }, `描述：${!dispatchPayload.context.descriptionIncluded ? '为空' : dispatchPayload.context.descriptionTruncated ? `已截取前 ${dispatchPayload.context.descriptionLimit} 字` : '已读取'}`),
                      h('span', { style: styles.badge }, dispatchPayload.context.commentsUnavailable
                        ? '评论：读取失败'
                        : `评论：已读 ${dispatchPayload.context.commentsIncluded}/${dispatchPayload.context.commentsTotal ?? dispatchPayload.context.commentsIncluded} 条（最多${dispatchPayload.context.commentLimit}条）${dispatchPayload.context.commentsTruncatedCount > 0 ? `；${dispatchPayload.context.commentsTruncatedCount}条内容已截断` : ''}`),
                      h('span', { style: styles.badge }, dispatchPayload.context.attachmentCount > 0
                        ? `附件：${dispatchPayload.context.attachmentCount} 个链接（未读取内容）`
                        : '附件：无'),
                      h('span', { style: styles.badge }, dispatchPayload.context.handoffsUnavailable
                        ? '交接记录：读取失败'
                        : `交接记录：读取 ${dispatchPayload.context.handoffCount} 条，带入 ${dispatchPayload.context.handoffContextIncludedCount} 条${dispatchPayload.context.handoffContextOmittedCount ? `，另有 ${dispatchPayload.context.handoffContextOmittedCount} 条未带入` : ''}${dispatchPayload.context.handoffSourceTruncatedCount ? `；${dispatchPayload.context.handoffSourceTruncatedCount} 条原评论已截断` : ''}${dispatchPayload.context.handoffsTruncated ? '；历史扫描不完整' : ''}`),
                      h('span', { style: styles.badge }, `快照：${dispatchPayload.context.snapshotAt ? new Date(dispatchPayload.context.snapshotAt).toLocaleString() : '刚刚'}`),
                    )
                  : null,
                dispatchKind === 'design'
                  ? h('div', { style: { margin: 14, padding: 14, border: `1px solid ${C.border}`, borderRadius: 8, lineHeight: '18px', fontSize: 12 } },
                      h('div', { style: { fontWeight: 650, marginBottom: 6 } }, 'AI 会做什么'),
                      h('div', { style: { color: C.sub } }, '先复述需求理解和方案优点，再指出有依据的歧义、冲突、遗漏和改进选项。优先讨论最可能阻塞开发的问题；你补充或选择后，AI 再整理成需求描述草稿、验收标准和未解决事项。'),
                      h('details', { style: { marginTop: 10 } },
                        h('summary', { style: { cursor: 'pointer', color: C.brand } }, '查看或编辑完整评审指令'),
                        h('textarea', {
                          style: { ...styles.textarea, minHeight: 180, marginTop: 8, width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '18px' },
                          value: dispatchDraft,
                          onChange: (event) => setDispatchDraft(event.target.value),
                          'aria-label': '查看或编辑需求评审指令',
                        }),
                      ),
                    )
                  : h('textarea', {
                      style: { ...styles.textarea, flex: 1, minHeight: 240, margin: 14, width: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '18px' },
                      value: dispatchDraft,
                      onChange: (event) => setDispatchDraft(event.target.value),
                      'aria-label': '编辑 agent 派发指令',
                    }),
                h('div', { style: { padding: '0 18px 12px', color: C.warn, fontSize: 11, lineHeight: '16px' } },
                  dispatchKind === 'design'
                    ? '确认后只创建需求评审会话草稿，不会写入评论或修改描述；进入会话后按回车才开始讨论。'
                    : '确认后会新建会话，并替换该会话当前未提交的草稿；agent 只有在你进入会话并按回车后才开始执行。'),
                h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: `1px solid ${C.border}` } },
                  h('button', { type: 'button', style: styles.button, disabled: busy === 'dispatch', onClick: () => setDispatchPayload(null) }, '取消'),
                  h('button', { type: 'button', style: styles.buttonPrimary, disabled: busy === 'dispatch' || !dispatchDraft.trim(), onClick: confirmDispatch },
                    busy === 'dispatch' ? '正在创建会话…' : '确认并创建会话'),
                ),
              ),
            )
          : null,
      )

      function renderDetail() {
        if (!selected) {
          return h('div', { style: styles.empty }, '选中左边一条工单，在这里查看明细、改状态或发评论。')
        }
        if (detailState === 'loading') return h('div', { style: styles.empty }, '正在加载明细…')
        if (detailState === 'error') {
          return h('div', { style: styles.empty },
            h('div', { style: { color: C.error, marginBottom: 8 } }, detailError),
            h('button', { type: 'button', style: styles.button, onClick: refreshDetail }, '重试'))
        }
        if (!detail) return null
        const issue = detail.issue
        const transforms = Array.isArray(detail.transforms) ? detail.transforms : []
        return h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h('span', { style: styles.num }, issue.issueNum),
            h(StatusBadge, { name: issue.statusName, type: issue.statusType }),
            h('div', { style: { flex: 1 } }),
            detail.consoleUrl
              ? h('button', { type: 'button', style: styles.buttonTiny, title: '复制链接', onClick: () => copyText(detail.consoleUrl || '') }, '复制链接')
              : null,
            detail.consoleUrl
              ? h('button', { type: 'button', style: styles.buttonTiny, onClick: () => window.open(detail.consoleUrl, '_blank', 'noopener') }, '控制台')
              : null,
          ),
          h('div', { style: { fontSize: 14, lineHeight: '20px', fontWeight: 600, marginBottom: 8 } }, issue.summary || '(无概要)'),
          h('div', { style: { fontSize: 11, color: C.sub, lineHeight: '17px', marginBottom: 10 } },
            `${issue.typeName || issue.typeCode || '-'} · ${issue.priority || '无优先级'} · 经办人 ${issue.assignee || '未指派'} · 创建人 ${issue.reporter || '-'}`,
            h('br'),
            `创建 ${issue.creationDate || '-'} · 更新 ${issue.lastUpdateDate || '-'}`,
          ),

          // status
          h('div', { style: styles.card },
            h('span', { style: styles.label }, `变更状态（当前「${issue.statusName}」，共 ${transforms.length} 个可选项）`),
            transforms.length === 0
              ? h('div', { style: { fontSize: 11, color: C.sub } }, detail.transformsError || '当前状态没有可用的转换')
              : h('select', {
                  style: { ...styles.input, width: '100%' },
                  value: '',
                  onChange: (event) => {
                    const found = transforms.find((item) => item.id === event.target.value)
                    setPendingTransform(found || null)
                    event.target.value = ''
                  },
                },
                  h('option', { value: '' }, '选择目标状态…'),
                  transforms.map((item) => h('option', { key: item.id, value: item.id }, `→ ${item.targetStatusName}`)),
                ),
            pendingTransform
              ? h('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: 11, color: C.warn } },
                    `确认把 ${issue.issueNum} 从「${issue.statusName}」改为「${pendingTransform.targetStatusName}」？`),
                  h('button', {
                    type: 'button',
                    style: styles.buttonPrimary,
                    disabled: busy === 'status',
                    onClick: () => changeStatus(pendingTransform),
                  }, busy === 'status' ? '提交中…' : '确认变更'),
                  h('button', { type: 'button', style: styles.buttonTiny, onClick: () => setPendingTransform(null) }, '取消'),
                )
              : null,
          ),

          // dispatch
          h('div', { style: { position: 'relative', marginBottom: 10 } },
            h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: busy === 'dispatch' || busy === 'preview',
              onClick: () => setDispatchOpen((value) => !value),
            }, busy === 'dispatch' ? '正在创建会话…' : busy === 'preview' ? '正在准备草稿…' : '去处理 ▾'),
            dispatchOpen
              ? h('div', {
                  style: {
                    position: 'absolute',
                    zIndex: 20,
                    top: 32,
                    left: 0,
                    minWidth: 216,
                    padding: 6,
                    borderRadius: 8,
                    border: `1px solid ${C.border}`,
                    background: C.overlay,
                    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  },
                },
                  h('button', { type: 'button', style: { ...styles.button, textAlign: 'left', border: 'none' }, onClick: () => prepareDispatch('fix') }, '数据修复'),
                  h('button', { type: 'button', style: { ...styles.button, textAlign: 'left', border: 'none' }, onClick: () => prepareDispatch('bug') }, 'Bug 排查'),
                  h('button', {
                    type: 'button',
                    style: { ...styles.button, textAlign: 'left', border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
                    onClick: () => prepareDispatch('design'),
                  },
                    h('span', null, '去设计'),
                    h('span', { style: { fontSize: 10, color: C.sub, fontWeight: 400 } }, '评审方案并补齐开发信息')),
                  h('button', { type: 'button', style: { ...styles.button, textAlign: 'left', border: 'none' }, onClick: () => prepareDispatch('dev') }, '需求开发'),
                  h('div', { style: { fontSize: 10, color: C.sub, padding: '4px 6px' } }, '会在会话里生成草稿，确认后回车才开跑'),
                )
              : null,
          ),

          // tabs
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            h('button', { type: 'button', style: tab === 'detail' ? styles.buttonPrimary : styles.button, onClick: () => setTab('detail') }, '描述'),
            h('button', { type: 'button', style: tab === 'comments' ? styles.buttonPrimary : styles.button, onClick: () => setTab('comments') },
              `评论 ${comments && comments.ok ? comments.total : ''}`.trim()),
            h('button', { type: 'button', style: tab === 'handoffs' ? styles.buttonPrimary : styles.button, onClick: () => setTab('handoffs') }, '协作记录'),
          ),

          tab === 'detail'
            ? h('div', null,
                descriptionHtml
                  ? h('div', {
                      className: 'cw-prose',
                      onClick: openImagePreview,
                      dangerouslySetInnerHTML: { __html: descriptionHtml },
                    })
                  : h('div', { style: { fontSize: 12, color: C.sub } }, '（工单没有填写描述）'),
                issue.attachments && issue.attachments.length > 0
                  ? h('div', { style: { marginTop: 12 } },
                      h('div', { style: styles.sectionTitle }, `附件 ${issue.attachments.length}`),
                      issue.attachments.map((item, index) =>
                        h('a', {
                          key: `${item.url}-${index}`,
                          href: item.url,
                          target: '_blank',
                          rel: 'noopener',
                          style: { display: 'block', fontSize: 11, color: C.brand, marginBottom: 4, wordBreak: 'break-all' },
                        }, `📎 ${item.fileName || '附件'}`),
                      ),
                    )
                  : null,
              )
            : tab === 'comments' ? renderComments() : renderHandoffs(),
        )
      }

      function renderHandoffs() {
        const data = handoffData
        const items = data && Array.isArray(data.items) ? data.items : []
        return h('div', null,
          h('div', { style: { ...styles.row, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
            h('select', {
              style: styles.input,
              value: handoffRole,
              disabled: handoffUncertain,
              onChange: (event) => chooseHandoffRole(event.target.value),
              'aria-label': '交接记录角色',
            }, Object.entries(HANDOFF_ROLES).map(([key, label]) => h('option', { key, value: key }, label))),
            h('button', { type: 'button', style: styles.button, disabled: busy === 'handoff-template' || handoffUncertain, onClick: prepareHandoff },
              busy === 'handoff-template' ? '生成中…' : '生成交接模板'),
            h('button', { type: 'button', style: styles.buttonTiny, disabled: Boolean(data && data.loading), onClick: () => setHandoffReload((value) => value + 1) }, '刷新记录'),
          ),
          h('div', { style: { fontSize: 11, color: C.sub, marginBottom: 10 } }, '团队共享记录保存在猪齿鱼评论中；切换角色会清空当前草稿。发布只会在点击下方按钮后发生。'),
          data && data.loading ? h('div', { style: styles.empty }, '正在读取共享交接记录…') : null,
          data && data.ok === false ? h('div', { style: styles.notice('error') }, `读取交接记录失败：${data.error || '未知错误'}`) : null,
          data && data.ok && data.truncated ? h('div', { style: styles.notice('warn'), role: 'status' }, `扫描到 ${data.scannedComments}/${data.totalComments} 条评论；历史可能更长，较早的交接记录可能未读取。`) : null,
          data && data.ok && !data.truncated ? h('div', { style: { fontSize: 11, color: C.sub, marginBottom: 8 } }, `已扫描 ${data.scannedComments} 条评论，发现 ${items.length} 条交接记录。`) : null,
          handoffUncertain ? h('div', { style: { ...styles.notice('warn'), marginBottom: 8 }, role: 'alert' },
            h('span', null, '上次发布结果尚未核实。先到猪齿鱼检查评论；确认没有发布后，再解除保护。'),
            h('button', { type: 'button', style: styles.buttonTiny, onClick: releaseHandoffRetry }, '确认未发布，允许重试')) : null,
          h('div', { style: { border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, margin: '10px 0' } },
            h('div', { style: styles.sectionTitle }, '交接草稿'),
            h('textarea', {
              style: { ...styles.textarea, minHeight: 220, width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
              value: handoffDraft,
              disabled: handoffUncertain,
              onChange: (event) => setHandoffDraft(event.target.value),
              placeholder: '生成模板后填写交接内容；保留首行角色标记以便其他角色识别。',
              'aria-label': '编辑交接记录草稿',
            }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
              h('button', {
                type: 'button',
                style: styles.buttonPrimary,
                disabled: busy === 'handoff-publish' || handoffUncertain || !handoffDraft.trim().startsWith(`【阶段交接 v1｜${HANDOFF_ROLES[handoffRole]}】`),
                onClick: publishHandoff,
              }, busy === 'handoff-publish' ? '发布并核实中…' : '发布交接记录')),
          ),
          h('div', { style: styles.sectionTitle }, `近期共享交接 ${items.length}`),
          items.length === 0 && data && data.ok ? h('div', { style: { fontSize: 11, color: C.sub, padding: '8px 0' } }, '当前扫描范围内没有带角色标记的交接评论。') : null,
          items.map((item) => h('div', { key: item.commentId, style: { ...styles.comment, marginBottom: 8 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 } },
              h('strong', null, item.stage || '阶段交接'),
              h('span', { style: { fontSize: 10, color: C.sub } }, `${item.user || '未知'} · ${formatTime(item.lastUpdateDate)}`)),
            item.truncated ? h('div', { style: { ...styles.notice('warn'), marginBottom: 5 } }, '原评论超过读取上限，以下内容不完整；请打开猪齿鱼原评论查看剩余部分。') : null,
            h('div', { style: { fontSize: 11, lineHeight: '17px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, item.text))),
        )
      }

      function renderComments() {
        if (!comments) return h('div', { style: styles.empty }, '正在加载评论…')
        if (comments.ok === false) return h('div', { style: styles.empty },
          h('div', { style: { color: C.error, marginBottom: 8 } }, comments.error || '评论加载失败'),
          h('button', { type: 'button', style: styles.button, disabled: busy === 'detail', onClick: refreshDetail }, '重试加载评论'))
        const items = Array.isArray(comments.items) ? comments.items : []
        return h('div', null,
          items.length === 0 ? h('div', { style: { fontSize: 11, color: C.sub, padding: '8px 0' } }, '还没有评论') : null,
          items.map((item) =>
            h('div', { key: item.commentId, style: styles.comment },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 } },
                h('span', { style: { fontSize: 11, fontWeight: 600 } }, item.user || '未知'),
                h('span', { style: { fontSize: 10, color: C.sub } }, formatTime(item.lastUpdateDate)),
                h('div', { style: { flex: 1 } }),
                settings && item.loginName === settings.username
                  ? h('button', { type: 'button', style: styles.buttonTiny, onClick: () => removeComment(item) }, '删除')
                  : null,
              ),
              h(CommentBody, { html: item.textHtml, text: item.text, onImageClick: openImagePreview }),
            ),
          ),
          h('div', { style: { marginTop: 10 } },
            h('textarea', {
              style: styles.textarea,
              placeholder: '写评论（支持 Markdown，和猪齿鱼网页一致）',
              value: commentDraft,
              onChange: (event) => setCommentDraft(event.target.value),
            }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 } },
              h('button', {
                type: 'button',
                style: styles.buttonPrimary,
                disabled: busy === 'comment' || commentDraft.trim().length === 0,
                onClick: submitComment,
              }, busy === 'comment' ? '发送中…' : '发表评论'),
            ),
          ),
        )
      }
    }

    function dateFilterBar(list, range, actions) {
      const preset = range ? range.preset : 'm3'
      const known = RANGE_PRESETS.some((item) => item.value === preset)
      const filter = list.filter
      return h(
        'div',
        { style: styles.filterBar },
        h('span', { style: { fontWeight: 600, color: C.text } }, '创建时间'),
        h('select', {
          style: { ...styles.input, height: 26, fontSize: 11 },
          value: preset,
          onChange: (event) => actions.onPreset(event.target.value),
          'aria-label': '创建时间范围',
        },
          !known && /^m\d+$/.test(preset)
            ? h('option', { value: preset }, `近 ${preset.slice(1)} 个月（默认）`)
            : null,
          RANGE_PRESETS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
        ),
        h('input', {
          type: 'date',
          style: styles.dateInput,
          value: range ? range.since : '',
          onChange: (event) => actions.onSince(event.target.value),
          'aria-label': '创建时间起始日期',
        }),
        h('span', null, '~'),
        h('input', {
          type: 'date',
          style: styles.dateInput,
          value: range ? range.until : '',
          onChange: (event) => actions.onUntil(event.target.value),
          'aria-label': '创建时间结束日期',
        }),
        h('select', {
          style: { ...styles.input, height: 26, fontSize: 11 },
          value: actions.sort,
          onChange: (event) => actions.onSort(event.target.value),
          'aria-label': '任务排序',
          title: '服务端按主工单排序并保持跨页顺序；接口附带的子任务仍随树形结果展示',
        }, SORT_OPTIONS.map((item) => h('option', { key: item.value, value: item.value }, `排序：${item.label}`))),
        h('button', {
          type: 'button',
          style: styles.buttonTiny,
          onClick: actions.onClear,
          title: '恢复当前项目的默认筛选、排序和时间范围',
        }, '清除筛选'),
        h('div', { style: { flex: 1 } }),
        h('span', { style: { fontSize: 11 } },
          (filter && filter.selfOnly && filter.label ? `${filter.label} = 我 · ` : '') +
          (filter && filter.unfinished ? '只看未完成 · ' : '') +
          (filter && filter.dateActive ? `创建于 ${filter.since} ~ ${filter.until} · ` : '全部时间 · ') +
          `共 ${list.total} 条`),
      )
    }

    // --------------------------------------------------------- settings page

    function SettingsSection() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [password, setPassword] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [fieldOptions, setFieldOptions] = React.useState({})
      const [search, setSearch] = React.useState('')
      const [candidates, setCandidates] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let cancelled = false
        apiGet('/state')
          .then((data) => {
            if (cancelled) return
            setState(data)
            setDraft(data.settings)
            setProjects(data.settings.projects || [])
          })
          .catch((err) => {
            if (!cancelled) setError(errorText(err))
          })
        return () => {
          cancelled = true
        }
      }, [])

      React.useEffect(() => {
        if (!projects.length) return undefined
        let cancelled = false
        Promise.all(
          projects.map((item) =>
            apiGet('/fields', { projectId: item.projectId })
              .then((data) => ({ projectId: item.projectId, fields: data.fields || [] }))
              .catch(() => ({ projectId: item.projectId, fields: [] })),
          ),
        ).then((results) => {
          if (cancelled) return
          const next = {}
          for (const item of results) next[item.projectId] = item.fields
          setFieldOptions(next)
        })
        return () => {
          cancelled = true
        }
      }, [projects.map((item) => item.projectId).join(',')])

      function patchDraft(patch) {
        setDraft((current) => ({ ...(current || {}), ...patch }))
      }

      function patchProject(projectId, patch) {
        setProjects((current) =>
          current.map((item) => (item.projectId === projectId ? { ...item, ...patch } : item)),
        )
      }

      async function searchProjects() {
        const query = search.trim()
        if (!query) return
        setBusy('search')
        try {
          const data = await apiGet('/projects/all', { q: query })
          setCandidates(data.items || [])
          if (!data.items || data.items.length === 0) setNotice({ tone: 'warn', text: '没有找到匹配的项目' })
        } catch (err) {
          setNotice({ tone: 'error', text: `搜索失败：${errorText(err)}` })
        } finally {
          setBusy('')
        }
      }

      function addProject(candidate) {
        if (projects.some((item) => item.projectId === candidate.projectId)) {
          setNotice({ tone: 'warn', text: '这个项目已经在关注列表里了' })
          return
        }
        setProjects((current) => [
          ...current,
          {
            projectId: candidate.projectId,
            code: candidate.code,
            name: candidate.name,
            category: candidate.category || '',
            filter: { code: 'assignee', name: '经办人', fieldType: 'member', predefined: true },
          },
        ])
        setCandidates([])
        setSearch('')
      }

      function removeProject(projectId) {
        setProjects((current) => current.filter((item) => item.projectId !== projectId))
      }

      async function save() {
        setBusy('save')
        setNotice(null)
        try {
          const patch = { ...(draft || {}) }
          delete patch.hasPassword
          patch.projects = projects
          if (password) patch.password = password
          const data = await apiPost('/settings', { settings: patch })
          setState((current) => ({ ...(current || {}), settings: data.settings }))
          setDraft(data.settings)
          setPassword('')
          setNotice({ tone: 'ok', text: '设置已保存' })
        } catch (err) {
          setNotice({ tone: 'error', text: `保存失败：${errorText(err)}` })
        } finally {
          setBusy('')
        }
      }

      async function test() {
        setBusy('test')
        setNotice(null)
        try {
          const data = await apiPost('/test', {})
          setNotice({
            tone: 'ok',
            text: `登录成功：${data.user.realName}（${data.user.loginName}）· 星标项目 ${data.starCount} 个 · ${data.projects
              .map((item) => `${item.name}:${item.error ? '失败' : item.total}`)
              .join(' / ')}`,
          })
        } catch (err) {
          setNotice({ tone: 'error', text: `连接失败：${errorText(err)}` })
        } finally {
          setBusy('')
        }
      }

      if (error) return h('div', { style: { padding: 16, color: C.error, fontSize: 12 } }, error)
      if (!draft) return h('div', { style: { padding: 16, color: C.sub, fontSize: 12 } }, '加载设置…')

      return h('div', { style: { padding: '4px 2px 24px', maxWidth: 720 } },
        h(Notice, { notice }),
        h('div', { style: styles.sectionTitle }, '账号'),
        field('网关地址', h('input', {
          style: { ...styles.input, width: '100%' },
          value: draft.baseUrl || '',
          placeholder: '例如 https://choerodon-gateway.example.com',
          onChange: (e) => patchDraft({ baseUrl: e.target.value }),
        })),
        field('用户名 / 手机号', h('input', { style: { ...styles.input, width: '100%' }, value: draft.username || '', onChange: (e) => patchDraft({ username: e.target.value }) })),
        field(
          `密码${state && state.settings && state.settings.hasPassword ? '（已配置，留空不修改）' : ''}`,
          h('input', {
            style: { ...styles.input, width: '100%' },
            type: 'password',
            value: password,
            placeholder: state && state.settings && state.settings.hasPassword ? '••••••••' : '请输入密码',
            onChange: (e) => setPassword(e.target.value),
          }),
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          field('组织 ID', h('input', { style: { ...styles.input, width: 120 }, value: draft.organizationId || '', onChange: (e) => patchDraft({ organizationId: e.target.value }) })),
          field('租户 ID', h('input', { style: { ...styles.input, width: 120 }, value: draft.tenantId || '', onChange: (e) => patchDraft({ tenantId: e.target.value }) })),
        ),

        h('div', { style: styles.sectionTitle }, '会话与派发'),
        field(
          '会话根目录（派发时按项目 code 建子目录）',
          h('input', {
            style: { ...styles.input, width: '100%' },
            value: draft.sessionRoot || '',
            placeholder: '留空则使用 ~/choerodon-sessions',
            onChange: (e) => patchDraft({ sessionRoot: e.target.value }),
          }),
        ),
        field(
          '控制台 URL 模板（可选，用于「打开控制台 / 复制链接」）',
          h('input', {
            style: { ...styles.input, width: '100%' },
            value: draft.detailUrlTemplate || '',
            placeholder: 'https://console.example.com/#/issue?id={projectId}&issueId={issueId}',
            onChange: (e) => patchDraft({ detailUrlTemplate: e.target.value }),
          }),
        ),
        h('div', { style: { fontSize: 10, color: C.sub, marginTop: -6, marginBottom: 12 } },
          '可用占位符：{projectId} {projectName} {category} {orgId} {issueId} {issueNum}；留空则不显示控制台按钮。'),
        h('div', { style: { display: 'flex', gap: 24, alignItems: 'flex-start' } },
          field('每页条数', h('input', { style: { ...styles.input, width: 100 }, type: 'number', value: String(draft.pageSize || 20), onChange: (e) => patchDraft({ pageSize: Number(e.target.value) || 20 }) })),
          field(
            '默认时间范围（月）',
            h('input', {
              style: { ...styles.input, width: 100 },
              type: 'number',
              min: 0,
              max: 120,
              value: String(draft.defaultLookbackMonths ?? 3),
              onChange: (e) =>
                patchDraft({ defaultLookbackMonths: Math.max(0, Math.min(120, Number(e.target.value) || 0)) }),
            }),
          ),
          field('派发模式', h('select', { style: styles.input, value: draft.dispatchMode || 'draft', onChange: (e) => patchDraft({ dispatchMode: e.target.value }) },
            h('option', { value: 'draft' }, '草稿（确认后回车）'),
          )),
        ),
        h('div', { style: { fontSize: 10, color: C.sub, marginTop: -6, marginBottom: 12 } },
          '默认只看创建时间在近 3 个月内的工单；填 0 表示不限时间。面板顶部可随时改快捷范围或自定义起止日期，改动会记住。'),

        h('div', { style: styles.sectionTitle }, '关注的项目'),
        projects.map((project) =>
          h('div', { key: project.projectId, style: styles.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, project.name),
              h('span', { style: { fontSize: 11, color: C.sub } }, `${project.code} · ${project.projectId}`),
              h('div', { style: { flex: 1 } }),
              h('button', { type: 'button', style: styles.buttonTiny, onClick: () => removeProject(project.projectId) }, '移除'),
            ),
            h('span', { style: styles.label }, '「只看我」使用的字段'),
            h('select', {
              style: { ...styles.input, width: '100%' },
              value: project.filter ? project.filter.code : 'assignee',
              onChange: (event) => {
                const option = (fieldOptions[project.projectId] || []).find((item) => item.code === event.target.value)
                patchProject(project.projectId, {
                  filter: option
                    ? { code: option.code, name: option.name, fieldType: option.fieldType, predefined: Boolean(option.predefined) }
                    : { code: 'assignee', name: '经办人', fieldType: 'member', predefined: true },
                })
              },
            },
              h('option', { value: 'assignee' }, '经办人（预定义）'),
              (fieldOptions[project.projectId] || [])
                .filter((item) => item.code !== 'assignee')
                .map((item) => h('option', { key: item.code, value: item.code }, `${item.name}（${item.fieldType}）`)),
            ),
            h('div', { style: { fontSize: 10, color: C.sub, marginTop: 4 } },
              '自定义人员字段会按项目实时解析字段 ID；过滤不生效时列表顶部会提示。'),
          ),
        ),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
          h('input', {
            style: { ...styles.input, flex: 1 },
            placeholder: '搜索项目名称 / code / ID 后添加',
            value: search,
            onChange: (event) => setSearch(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') searchProjects()
            },
          }),
          h('button', { type: 'button', style: styles.button, disabled: busy === 'search', onClick: searchProjects },
            busy === 'search' ? '搜索中…' : '搜索'),
        ),
        candidates.length > 0
          ? h('div', { style: { ...styles.card, maxHeight: 260, overflow: 'auto' } },
              candidates.map((item) =>
                h('div', { key: item.projectId, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
                  h('span', { style: { fontSize: 12 } }, item.name),
                  h('span', { style: { fontSize: 11, color: C.sub } }, `${item.code} · ${item.projectId}${item.starFlag ? ' · 星标' : ''}`),
                  h('div', { style: { flex: 1 } }),
                  h('button', { type: 'button', style: styles.buttonTiny, onClick: () => addProject(item) }, '添加'),
                ),
              ),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 8, marginTop: 20 } },
          h('button', { type: 'button', style: styles.buttonPrimary, disabled: busy === 'save', onClick: save },
            busy === 'save' ? '保存中…' : '保存设置'),
          h('button', { type: 'button', style: styles.button, disabled: busy === 'test', onClick: test },
            busy === 'test' ? '测试中…' : '测试连接'),
          h('div', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 10, color: C.sub, alignSelf: 'center' } }, state && state.settingsFile ? state.settingsFile : ''),
        ),
      )
    }

    function field(label, control) {
      return h('div', { style: styles.field }, h('span', { style: styles.label }, label), control)
    }

    // -------------------------------------------------------------- registry

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 20
      const color = props && props.active ? C.brand : 'currentColor'
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', color },
        },
        h('rect', { x: 2.6, y: 3.6, width: 18.8, height: 16.8, rx: 3.6, fill: 'none', stroke: color, strokeWidth: 1.7 }),
        h('path', { d: 'M7 8.4h10M7 12h10M7 15.6h6', fill: 'none', stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('circle', { cx: 18.6, cy: 15.6, r: 1.9, fill: color }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        const disposers = []
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'choerodon', order: 20, label: '猪齿鱼任务' },
              PanelIcon,
            ),
          ),
        )
        disposers.push(
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'choerodon' }, Panel)),
        )
        disposers.push(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'choerodon', order: 30, label: '猪齿鱼' },
              SettingsSection,
            ),
          ),
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (error) {
              console.error(error)
            }
          }
        }
      },
    }
  },
})
