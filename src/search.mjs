import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectEntries } from './indexer.mjs'
import { cleanInline, msToStr, truncateBytes, truncateChars } from './util.mjs'

function matchPos(text, keyword, useRegex) {
  if (!text || !keyword) return -1
  if (useRegex) {
    try {
      const m = new RegExp(keyword, 'i').exec(text)
      return m ? m.index : -1
    } catch { return -1 }
  }
  return text.toLowerCase().indexOf(String(keyword).toLowerCase())
}

function roundAt(text, pos) {
  const head = text.slice(0, Math.max(0, pos))
  const re = /^## 第\s*(\d+)\s*轮/gm
  let m
  let last = 0
  while ((m = re.exec(head))) last = Number(m[1])
  return last
}

function snippet(text, pos, width = 40) {
  const left = Math.max(0, pos - width)
  const right = Math.min(text.length, pos + width)
  let s = text.slice(left, right).replace(/\s+/g, ' ').trim()
  if (left > 0) s = '…' + s
  if (right < text.length) s = s + '…'
  return truncateChars(s, 240)
}

function entryMatches(e, { tag, date, since, until, workspace }) {
  if (tag && !e.tags.includes(tag)) return false
  if (date && e.date !== date) return false
  if (since && e.date < since) return false
  if (until && e.date > until) return false
  if (workspace) {
    const w = workspace.toLowerCase()
    if (!e.workspace.toLowerCase().includes(w) && !e.title.toLowerCase().includes(w) && !e.first_ask.toLowerCase().includes(w)) return false
  }
  return true
}

export function search(cfg, {
  tag = null, keyword = null, date = null, since = null, until = null,
  workspace = null, limit = 10, regex = false, deep = false,
} = {}) {
  const entries = collectEntries(cfg)
  const candidates = entries.filter((e) => entryMatches(e, { tag, date, since, until, workspace }))
  const results = []
  if (!keyword) {
    for (const e of candidates.slice(0, limit)) {
      results.push({
        date: e.date, workspace: e.workspace, session: e.session, title: e.title,
        round: 0, file: e.file, tags: e.tags, keywords: e.keywords,
        snippet: cleanInline(e.first_ask || e.title || '', 200), matched_in: '目录项',
      })
    }
    return results
  }
  for (const e of candidates) {
    if (results.length >= limit) break
    let text = ''
    try { text = readFileSync(e.file, 'utf8') } catch { continue }
    let body = text
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3)
      if (end >= 0) body = text.slice(end + 4)
    }
    if (!deep) {
      const pos = matchPos(body, keyword, regex)
      if (pos < 0) continue
      results.push({
        date: e.date, workspace: e.workspace, session: e.session, title: e.title,
        round: roundAt(body, pos), file: e.file, tags: e.tags, keywords: e.keywords,
        snippet: snippet(body, pos), matched_in: 'md',
      })
      continue
    }
    const jp = e.file.replace(/\.md$/i, '.json')
    if (!existsSync(jp)) continue
    let obj
    try { obj = JSON.parse(readFileSync(jp, 'utf8')) } catch { continue }
    let titleHit = false
    for (const field of ['title', 'first_ask']) {
      const pos = matchPos(String(obj[field] || ''), keyword, regex)
      if (pos >= 0) {
        results.push({
          date: e.date, workspace: e.workspace, session: e.session, title: e.title,
          round: 0, file: e.file, tags: e.tags, keywords: e.keywords,
          snippet: snippet(String(obj[field] || ''), pos), matched_in: field,
        })
        titleHit = true
        break
      }
    }
    if (titleHit) continue
    for (const r of obj.rounds || []) {
      if (results.length >= limit) break
      for (const it of r.items || []) {
        let t = String(it.text || '')
        if ((it.tool_calls || []).length) {
          t += '\n' + it.tool_calls.map((c) => `${c.name || ''} ${c.arguments || ''}`).join('\n')
        }
        const pos = matchPos(t, keyword, regex)
        if (pos >= 0) {
          results.push({
            date: e.date, workspace: e.workspace, session: e.session, title: e.title,
            round: Number(r.round || 0), file: e.file, tags: e.tags, keywords: e.keywords,
            snippet: snippet(t, pos), matched_in: it.role || 'json',
          })
          break
        }
      }
    }
  }
  return results
}

export function formatResults(results) {
  if (!results.length) return '没有命中。'
  return results.map((r, i) => {
    const lines = [
      `[${i + 1}] ${r.date} · ${r.workspace} · ${r.title || r.session} (${r.session})` +
      (r.round ? ` · 第 ${r.round} 轮` : ''),
      `    文件: ${r.file}`,
    ]
    if (r.tags?.length) lines.push(`    标签: ${r.tags.join('、')}`)
    lines.push(`    片段: ${r.snippet}`)
    return lines.join('\n')
  }).join('\n')
}

function renderItem(it) {
  const lines = []
  if (it.role === 'user') {
    lines.push(`### 用户${it.source && it.source !== 'user' ? `（${it.source}）` : ''} · ${it.time || ''}`)
    lines.push('')
    if (it.text) { lines.push(it.text); lines.push('') }
  } else if (it.role === 'system') {
    lines.push(`### 系统提示（${it.source || 'system'}） · ${it.time || ''}`)
    lines.push('')
    if (it.text) { lines.push(it.text); lines.push('') }
  } else if (it.role === 'assistant') {
    lines.push(`### 助手 · ${it.time || ''}`)
    lines.push('')
    if (it.text) { lines.push(it.text); lines.push('') }
    for (const c of it.tool_calls || []) lines.push(`> 工具调用 \`${c.name || '?'}\`：${truncateChars(c.arguments || '', 800)}`)
    if ((it.tool_calls || []).length) lines.push('')
  } else if (it.role === 'tool') {
    const [text, omitted] = truncateBytes(it.text || '', 4096)
    lines.push(`> 工具结果（\`${it.tool_name || '工具'}\`） · ${it.time || ''}`)
    lines.push('')
    if (text) { lines.push(text); lines.push('') }
    if (omitted) { lines.push(`…[截断 ${omitted} 字节，完整原文见 .json]…`); lines.push('') }
  }
  for (const img of it.images || []) lines.push(`[图片 ${img.name || ''} ${img.width || ''}x${img.height || ''}]`)
  return lines
}

export function readRange(cfg, file, turnFrom, turnTo) {
  let p = String(file)
  if (/\.md$/i.test(p)) p = p.replace(/\.md$/i, '.json')
  if (!existsSync(p)) throw new Error(`找不到结构化副本：${p}`)
  const obj = JSON.parse(readFileSync(p, 'utf8'))
  const selected = (obj.rounds || []).filter((r) => Number(r.round) >= turnFrom && Number(r.round) <= turnTo)
  const lines = [
    `# ${obj.workspace} · ${obj.date} · ${obj.title || obj.session}`,
    '',
    `> 会话：\`${obj.session_id}\` ｜ 读取轮次：${turnFrom}–${turnTo} ｜ 本文件轮次：${obj.turns} / 全会话：${obj.session_turns}`,
    `> 文件：\`${p}\``,
    '',
  ]
  if (!selected.length) {
    lines.push('（该范围没有轮次。用 `search` 先看命中的轮次号。）')
    return lines.join('\n')
  }
  for (const r of selected) {
    lines.push(`## 第 ${r.round} 轮 · ${r.time || msToStr(r.time_ms)}`)
    lines.push('')
    for (const it of r.items || []) {
      lines.push(...renderItem(it))
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\s+$/, '') + '\n'
}
