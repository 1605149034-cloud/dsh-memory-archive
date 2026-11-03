import { join } from 'node:path'
import { imagePlaceholder } from './session.mjs'
import { firstAskShort } from './session.mjs'
import {
  frontMatterDump, msToStr, sanitizeName, truncateBytes, truncateChars, writeTextIfChanged,
} from './util.mjs'
import { archiveDir } from './config.mjs'

const FRONT_ORDER = [
  'date', 'workspace', 'session', 'turns', 'first_ask', 'summary',
  'tags', 'keywords', 'session_id', 'session_turns', 'date_scope',
  'title', 'title_source', 'source_file', 'compactions',
]

export function buildMeta(cfg, data, date, rounds, workspace, tags, keywords) {
  return {
    date,
    workspace,
    session: data.session_short,
    turns: rounds.length,
    first_ask: firstAskShort(data, 80),
    summary: '',
    tags: tags || [],
    keywords: keywords || [],
    session_id: data.session_id,
    session_turns: data.rounds.length,
    date_scope: 'day-slice',
    title: data.title || '',
    title_source: data.title_source || '',
    source_file: data.path,
    compactions: (data.compactions || []).length,
  }
}

export function renderMarkdown(meta, data, rounds) {
  const lines = [frontMatterDump(meta, FRONT_ORDER), '']
  lines.push(`# ${meta.workspace} · ${meta.date}`)
  lines.push('')
  lines.push(`> 会话：\`${meta.session_id}\`${meta.title ? `（${meta.title}）` : ''}`)
  lines.push(`> 当日轮次：${meta.turns} / 全会话轮次：${meta.session_turns}`)
  lines.push(`> 首次提问：${meta.first_ask || '（无真人提问）'}`)
  lines.push(`> 源文件（只读引用）：\`${meta.source_file}\``)
  lines.push('')
  for (const r of rounds) {
    lines.push(`## 第 ${r.index} 轮 · ${msToStr(r.start_ms)}`)
    lines.push('')
    for (const it of r.items || []) {
      const ts = msToStr(it.time_ms)
      if (it.role === 'user') {
        lines.push(`### 用户${it.source && it.source !== 'user' ? `（${it.source}）` : ''} · ${ts}`)
        lines.push('')
        if (it.text) { lines.push(it.text); lines.push('') }
        for (const img of it.images || []) lines.push(imagePlaceholder(img))
        if ((it.images || []).length) lines.push('')
      } else if (it.role === 'system') {
        lines.push(`### 系统提示（${it.source || 'system'}） · ${ts}`)
        lines.push('')
        if (it.text) { lines.push(it.text); lines.push('') }
        for (const img of it.images || []) lines.push(imagePlaceholder(img))
        if ((it.images || []).length) lines.push('')
      } else if (it.role === 'assistant') {
        lines.push(`### 助手 · ${ts}`)
        lines.push('')
        if (it.text) { lines.push(it.text); lines.push('') }
        for (const c of it.tool_calls || []) {
          lines.push(`> 工具调用 \`${c.name || '?'}\`：${truncateChars(c.arguments || '', 800)}`)
        }
        if ((it.tool_calls || []).length) lines.push('')
        for (const img of it.images || []) lines.push(imagePlaceholder(img))
      } else if (it.role === 'tool') {
        const [text, omitted] = truncateBytes(it.text || '', 4096)
        lines.push(`> 工具结果（\`${it.tool_name || '工具'}\`） · ${ts}`)
        lines.push('')
        if (text) { lines.push(text); lines.push('') }
        if (omitted) { lines.push(`…[截断 ${omitted} 字节，完整原文见同名 .json]…`); lines.push('') }
        for (const img of it.images || []) lines.push(imagePlaceholder(img))
        if ((it.images || []).length) lines.push('')
      }
    }
    lines.push('')
  }
  if ((data.compactions || []).length) {
    lines.push(`## 上下文压缩摘要（共 ${data.compactions.length} 次）`)
    lines.push('')
    for (const c of data.compactions.slice(-2)) {
      lines.push(`### ${c.time || ''}`)
      lines.push('')
      lines.push(truncateChars(c.summary || '', 2000))
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\s+$/, '') + '\n'
}

export function renderJson(meta, data, rounds) {
  return JSON.stringify({
    ...meta,
    rounds: rounds.map((r) => ({
      round: r.index,
      time_ms: r.start_ms,
      time: msToStr(r.start_ms),
      date: r.date,
      has_human: !!r.has_human,
      items: (r.items || []).map((it) => ({
        role: it.role,
        time_ms: it.time_ms,
        time: msToStr(it.time_ms),
        source: it.source || '',
        text: it.text || '',
        images: it.images || [],
        tool_calls: it.tool_calls || [],
        tool_call_id: it.tool_call_id || '',
        tool_name: it.tool_name || '',
        reasoning_chars: it.reasoning_chars || 0,
      })),
    })),
    compactions: data.compactions || [],
    stats: data.stats || {},
  })
}

export function slicePaths(cfg, meta) {
  const base = `${sanitizeName(meta.workspace)}--${meta.session}`
  const d = join(archiveDir(cfg), meta.date)
  return { dir: d, md: join(d, `${base}.md`), json: join(d, `${base}.json`) }
}

export function writeSlice(cfg, data, date, rounds, meta) {
  const p = slicePaths(cfg, meta)
  const mdChanged = writeTextIfChanged(p.md, renderMarkdown(meta, data, rounds))
  const jsonChanged = writeTextIfChanged(p.json, renderJson(meta, data, rounds))
  return { ...p, mdChanged, jsonChanged }
}
