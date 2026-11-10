/** Plain-text helpers shared by the brief builder and the API normalizers. */

const ENTITIES = [
  ['&nbsp;', ' '],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
]

/** Convert one Choerodon description (HTML) into readable text, keeping image URLs. */
export function htmlToText(html, limit = 4000) {
  if (!html || typeof html !== 'string') return ''
  let text = html
    .replace(/<img[^>]*?src=["']([^"']+)["'][^>]*>/gi, (_match, src) => `\n[图片] ${src}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  for (const [entity, value] of ENTITIES) text = text.split(entity).join(value)
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (limit > 0 && text.length > limit) text = `${text.slice(0, limit)}\n…（内容已截断）`
  return text
}

/** Extract attachment descriptors from a detail payload. */
export function attachmentsOf(detail) {
  const list = Array.isArray(detail?.issueAttachmentVOList) ? detail.issueAttachmentVOList : []
  return list
    .map((item) => ({ fileName: String(item.fileName ?? item.name ?? ''), url: String(item.url ?? '') }))
    .filter((item) => item.fileName || item.url)
}

/** Render one console link from the configured template. */
export function detailUrl(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
}
