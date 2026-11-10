/**
 * Whitelist HTML renderer for Choerodon rich text (issue descriptions and
 * comments). Every tag is rebuilt from scratch: unknown tags lose the tag but
 * keep their text, all attributes are dropped except an explicit allowlist, and
 * every URL must be http(s). Images are rewritten to the plugin's local proxy so
 * private buckets and expired-looking tokens still load through the Host token.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
])

const VOID_TAGS = new Set(['br', 'hr', 'img'])

const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|noscript|template|svg|math|link|meta)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

const COMMENT_RE = /<!--[\s\S]*?-->/g

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

const ENTITIES = [
  ['&amp;', '&'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&#x27;', "'"],
  ['&apos;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
]

function decodeEntities(value) {
  let text = String(value || '')
  for (const [entity, decoded] of ENTITIES) text = text.split(entity).join(decoded)
  return text
}

function escapeAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function parseAttributes(raw) {
  const attributes = {}
  if (!raw) return attributes
  ATTRIBUTE_RE.lastIndex = 0
  let match = ATTRIBUTE_RE.exec(raw)
  while (match) {
    const name = match[1].toLowerCase()
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4]
    if (!(name in attributes)) attributes[name] = decodeEntities(value)
    match = ATTRIBUTE_RE.exec(raw)
  }
  return attributes
}

function safeUrl(value, schemes) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (/^(javascript|data|vbscript|file):/i.test(url.replace(/\s+/g, ''))) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (schemes && schemes.mailto && /^mailto:/i.test(url)) return url
  return ''
}

/**
 * Turn one Choerodon rich-text payload into a safe HTML fragment.
 * @param {string} html raw editor HTML
 * @param {(url: string) => string} imageRewrite maps an image URL to a local src
 * @returns {string} sanitized HTML
 */
export function sanitizeRichText(html, imageRewrite) {
  if (!html || typeof html !== 'string') return ''
  let source = html.replace(COMMENT_RE, '').replace(DROP_WITH_CONTENT, '')
  const output = []
  let cursor = 0
  TAG_RE.lastIndex = 0
  let match = TAG_RE.exec(source)
  while (match) {
    const text = source.slice(cursor, match.index)
    if (text) output.push(text)
    cursor = TAG_RE.lastIndex
    const closing = match[0].startsWith('</')
    const tag = match[1].toLowerCase()
    const rawAttributes = match[2] || ''

    if (!ALLOWED_TAGS.has(tag)) {
      match = TAG_RE.exec(source)
      continue
    }
    if (closing) {
      if (!VOID_TAGS.has(tag)) output.push(`</${tag}>`)
      match = TAG_RE.exec(source)
      continue
    }
    if (VOID_TAGS.has(tag)) {
      if (tag === 'br') output.push('<br>')
      else if (tag === 'hr') output.push('<hr>')
      else {
        const attributes = parseAttributes(rawAttributes)
        const original = safeUrl(attributes.src)
        if (original) {
          const rewritten = imageRewrite ? imageRewrite(original) : original
          const alt = escapeAttribute(attributes.alt || attributes.title || '')
          output.push(
            `<img src="${escapeAttribute(rewritten)}" alt="${alt}" loading="lazy" decoding="async">`,
          )
        }
      }
      match = TAG_RE.exec(source)
      continue
    }

    const attributes = parseAttributes(rawAttributes)
    const parts = []
    if (tag === 'a') {
      const href = safeUrl(attributes.href, { mailto: true })
      if (href) parts.push(`href="${escapeAttribute(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"')
    } else if (tag === 'td' || tag === 'th') {
      for (const name of ['colspan', 'rowspan']) {
        const value = Number(attributes[name])
        if (Number.isFinite(value) && value > 1 && value <= 100) {
          parts.push(`${name}="${Math.floor(value)}"`)
        }
      }
    }
    output.push(parts.length > 0 ? `<${tag} ${parts.join(' ')}>` : `<${tag}>`)
    match = TAG_RE.exec(source)
  }
  output.push(source.slice(cursor))
  return output.join('').trim()
}

/** Local proxy path for one remote image; the Host serves it with its own token. */
export const IMAGE_PREFIX = '/plugin/choerodon'

export function imageProxyPath(url, token) {
  return `${IMAGE_PREFIX}/image?t=${encodeURIComponent(token || '')}&url=${encodeURIComponent(url)}`
}
