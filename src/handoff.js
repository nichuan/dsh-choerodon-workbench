import { htmlToText } from './text.js'

export const HANDOFF_ROLES = {
  product: {
    label: '产品评审',
    nextRole: '研发',
    sections: [
      '已确认决策',
      '验收条件（建议编号 AC-01、AC-02…）',
      '待决策问题及影响',
    ],
  },
  engineering: {
    label: '研发提测',
    nextRole: '测试',
    sections: [
      '实现范围与改动位置',
      '代码分支 / 提交，或脚本及资源版本',
      '环境与数据准备',
      '已完成验证及证据',
      '测试关注点（关联验收条件）',
      '未完成事项与风险',
    ],
  },
  testing: {
    label: '测试结论',
    nextRole: '研发 / 产品',
    sections: [
      '测试版本与环境',
      '已执行用例及结果',
      '未执行用例与原因',
      '失败项 / 关联缺陷及证据',
      '验收条件覆盖与剩余风险',
    ],
  },
  operations: {
    label: '运维排障与上线验证',
    nextRole: '研发 / 运维',
    sections: [
      '发生环境与时间（注明时区）',
      '现象、影响范围与 traceId / 单据号',
      '已核实证据与根因（区分假设）',
      '临时恢复措施及结果',
      '发布版本、负责人、回退办法',
      '上线冒烟结果与证据',
      '遗留事项与风险',
    ],
  },
}

const HANDOFF_HEADER = /^【阶段交接 v1｜([^】]+)】/m
const HANDOFF_LIMIT = 5000

export function buildHandoffTemplate(role, issue = {}) {
  const config = HANDOFF_ROLES[role]
  if (!config) throw new Error(`未知交接角色：${role}`)
  const lines = [
    `【阶段交接 v1｜${config.label}】`,
    '',
    `工单：${issue.issueNum || '-'} ${issue.summary || ''}`.trim(),
    `项目：${issue.projectName || '-'}（${issue.projectCode || issue.projectId || '-'}）`,
    `记录时间：${new Date().toLocaleString()}`,
    '',
    '依据：',
    '- 工单描述、相关评论及本阶段核验材料；如有未读取或截断内容，请在此注明。',
    '',
  ]
  for (const section of config.sections) lines.push(`${section}：\n- `, '')
  lines.push('下一步：', '- ', '', `建议接手角色：${config.nextRole}`)
  return lines.join('\n')
}

export function parseHandoffComment(comment) {
  const text = htmlToText(String(comment?.text || ''), HANDOFF_LIMIT)
  const match = HANDOFF_HEADER.exec(text)
  if (!match) return null
  return {
    commentId: String(comment?.commentId || ''),
    user: String(comment?.user || '未知'),
    loginName: String(comment?.loginName || ''),
    lastUpdateDate: String(comment?.lastUpdateDate || ''),
    stage: match[1],
    truncated: text.endsWith('…（内容已截断）'),
    text,
  }
}

export function isHandoffComment(comment) {
  return Boolean(parseHandoffComment(comment))
}

export function normalizeHandoffText(value) {
  return htmlToText(String(value || ''), 0).replace(/\s+/g, ' ').trim()
}

export function formatHandoffsForPrompt(handoffs, { maxItems = 8, maxChars = 1800 } = {}) {
  const records = Array.isArray(handoffs) ? handoffs : []
  const items = records.slice(0, maxItems)
  if (items.length === 0) return ''
  const lines = ['## 猪齿鱼共享阶段交接记录（按工单评论读取）']
  if (records.length > maxItems) lines.push(`本次共发现 ${records.length} 条；以下仅带入最新 ${maxItems} 条，另有 ${records.length - maxItems} 条未放入本次会话上下文。`)
  for (const item of items) {
    const text = String(item.text || '').trim()
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…（本次会话中的交接摘要已截断）` : text
    const sourceWarning = item.truncated ? '（猪齿鱼原评论内容已超过读取上限，以下记录不完整。）\n' : ''
    lines.push('', `### ${item.stage || '阶段交接'} · ${item.user || '未知'} · ${item.lastUpdateDate || '时间未知'}`, `${sourceWarning}${clipped}`)
  }
  lines.push('', '- 上述内容来自猪齿鱼评论，是协作记录；若内容互相冲突或依据已变化，应回到工单原文和评论核实。')
  return lines.join('\n')
}
