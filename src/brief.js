import { htmlToText, detailUrl } from './text.js'

export const DISPATCH_KINDS = ['fix', 'bug', 'dev']

export const KIND_LABELS = {
  fix: '数据修复',
  bug: 'Bug 排查',
  dev: '需求开发',
}

const KIND_SKILLS = {
  fix: {
    skill: 'archery（必要时叠加 spuc-sql-generator）',
    goal: [
      '先只读定位：涉及哪些表、字段、当前真实值、受影响范围。',
      '给出修复 SQL 与回滚 SQL，说明执行顺序和风险；在我明确确认之前不要提交审批、不要执行写操作。',
    ],
  },
  bug: {
    skill: 'java-troubleshoot',
    goal: [
      '先判断是标准功能还是二开（适配器/脚本/API 挂载），有 traceId 就先查日志。',
      '定位到根因链路，给出证据（日志、SQL、traceId），再谈修复方案。',
    ],
  },
  dev: {
    skill: 'srm-requirement-delivery',
    goal: [
      '先判定交付形态：标准改造、Marmot 脚本二开，还是混合。',
      '给出影响面分析、实现方案和改动清单，再开始编码。',
    ],
  },
}

/**
 * Build the dispatch payload for one issue.
 * @param {object} input issue snapshot, dispatch kind, org id and console link
 * @returns {{title: string, prompt: string, kind: string}}
 */
export function buildBrief({ issue, kind, orgId, consoleUrl, comments = [], commentsUnavailable = false }) {
  const normalizedKind = KIND_SKILLS[kind] ? kind : 'bug'
  const profile = KIND_SKILLS[normalizedKind]
  const description = htmlToText(issue.descriptionHtml, 4000)
  const attachments = Array.isArray(issue.attachments) ? issue.attachments : []
  const lines = []

  lines.push(`# 猪齿鱼工单：${issue.issueNum} · ${issue.summary}`)
  lines.push('')
  lines.push(`- 项目：${issue.projectName}（${issue.projectId} / ${issue.projectCode || '-'}）`)
  lines.push(`- 类型 / 状态 / 优先级：${issue.typeName || '-'} / ${issue.statusName || '-'} / ${issue.priority || '-'}`)
  lines.push(`- 经办人：${issue.assignee || '-'}    创建人：${issue.reporter || '-'}`)
  lines.push(`- 更新时间：${issue.lastUpdateDate || '-'}`)
  if (consoleUrl) lines.push(`- 控制台：${consoleUrl}`)
  lines.push('')
  lines.push('## 描述')
  lines.push(description || '（工单没有填写描述）')
  if (attachments.length > 0) {
    lines.push('')
    lines.push('## 附件')
    for (const item of attachments) lines.push(`- ${item.fileName || '附件'}：${item.url}`)
  }
  lines.push('')
  lines.push('## 最近评论（最多 10 条）')
  if (commentsUnavailable) {
    lines.push('（评论读取失败，必要时通过猪齿鱼查询补全。）')
  } else if (comments.length === 0) {
    lines.push('（暂无评论）')
  } else {
    for (const item of comments.slice(0, 10)) {
      const text = htmlToText(String(item.text || ''), 1200)
      lines.push(`- ${item.user || '未知'} · ${item.lastUpdateDate || '时间未知'}：${text || '（空评论）'}`)
    }
  }
  lines.push('')
  lines.push(`## 处理目标：${KIND_LABELS[normalizedKind]}`)
  lines.push(`- 按 \`${profile.skill}\` 的流程执行。`)
  for (const goal of profile.goal) lines.push(`- ${goal}`)
  lines.push('')
  lines.push('## 补充')
  lines.push('- 上面的工单内容可能是只读快照。需要完整评论、附件或更多字段时，用 pangu MCP 的')
  lines.push('  choerodon_query_issue / choerodon_list_comments 复核后再动手。')
  lines.push('- 改工单状态、发评论由我在猪齿鱼任务面板里完成，不需要你代劳。')
  lines.push(`- 组织 ID：${orgId}；工单号前缀：${issue.projectCode || '-'}`)

  return {
    kind: normalizedKind,
    title: `${issue.issueNum} · ${KIND_LABELS[normalizedKind]}`,
    prompt: lines.join('\n'),
  }
}

export { detailUrl }
