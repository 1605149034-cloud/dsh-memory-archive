import { readFileSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { localDate, msToStr, truncateChars } from './util.mjs'

export const HUMAN_KINDS = new Set(['user', 'qq'])
export const SYSTEM_KINDS = new Set(['watch-together', 'schedule', 'user-approval'])
export const SKIP_KINDS = new Set([
  'runtime-context', 'skill-catalog', 'time-context', 'tool-jobs', 'goal', 'tool-goal',
  'compact-checkpoint', 'agent-instructions', 'repeat-tool-reminder', 'agent-message',
  'subagent-settled', 'working-directory',
])
const SCAFFOLD_PREFIXES = [
  'The approval policy changed',
  'Current runtime context',
  'This is an automatically generated checkpoint',
  'The DSH file sandbox',
  'You are an AI agent powered by DeepSeek Harness',
  'A skill is a reusable set',
  'The following workspace instructions',
  'This is a system reminder',
  '## 系统提醒',
]

export async function readZstdText(file) {
  const raw = readFileSync(file)
  return new Promise((resolve, reject) => {
    const stream = createZstdDecompress()
    const chunks = []
    const notes = []
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      if (chunks.length) {
        resolve({ text: Buffer.concat(chunks).toString('utf8'), notes, partial: !!err })
      } else {
        reject(err || new Error('zstd 解压结果为空'))
      }
    }
    stream.on('data', (c) => chunks.push(c))
    stream.on('error', (e) => {
      notes.push(`zstd 尾部截断：${e.message}`)
      finish(e)
    })
    stream.on('end', () => finish(null))
    try { stream.end(raw) } catch (e) { finish(e) }
  })
}

function blocks(content) {
  const texts = []
  const images = []
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && b.text) texts.push(String(b.text))
    if (b.type === 'image') {
      const a = b.attachment || {}
      images.push({
        name: a.name || '', media_type: a.mediaType || '',
        width: a.width, height: a.height, bytes: a.bytes,
        attachment_id: a.attachmentId || '',
      })
    }
  }
  return [texts, images]
}

export function imagePlaceholder(img) {
  const bits = []
  if (img.width && img.height) bits.push(`${img.width}x${img.height}`)
  if (img.bytes) bits.push(`${img.bytes} bytes`)
  return `[图片 ${img.name || 'image'}${bits.length ? ' ' + bits.join(' ') : ''}]`
}

function isScaffold(text) {
  const s = String(text || '').replace(/^\s+/, '')
  return SCAFFOLD_PREFIXES.some((p) => s.startsWith(p))
}

function addEventDate(set, ms) {
  if (typeof ms === 'number' && ms > 0) set.add(localDate(ms))
}

export function parseSessionEvents(text, { timezone = 'local', path = '' } = {}) {
  const rounds = []
  const events = []
  const stats = {
    events: 0, user_messages: 0, system_messages: 0, assistant_messages: 0,
    tool_calls: 0, tool_results: 0, images: 0, reasoning_chars: 0,
    tool_result_chars: 0, user_chars: 0, assistant_chars: 0,
    system_skipped: 0, scaffold_skipped: 0,
  }
  const typeCounter = {}
  const eventDates = new Set()
  const compactions = []
  const callNames = new Map()
  const seenCalls = new Set()
  let header = null
  let title = ''
  let titleSource = ''
  let firstAsk = ''
  let currentRound = null
  let roundNo = 0
  let lastMs = 0
  let badLines = 0

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { badLines++; continue }
    if (!ev || typeof ev !== 'object') continue
    const type = ev.type || ''
    const d = ev.data || {}
    let t = typeof ev.time === 'number' ? ev.time : 0
    typeCounter[type] = (typeCounter[type] || 0) + 1
    stats.events++
    if (t > 0) { addEventDate(eventDates, t); lastMs = Math.max(lastMs, t) }

    if (type === 'session') {
      header = ev
      const c = Number(ev.createdAt || 0)
      if (c > 0) { addEventDate(eventDates, c); lastMs = Math.max(lastMs, c) }
      continue
    }
    if (type === 'session/title') {
      if (d.title) { title = String(d.title).trim(); titleSource = String(d.source?.kind || '') }
      continue
    }
    if (type === 'compaction/summary') {
      const [texts] = blocks(d.summary || [])
      const summary = texts.join('\n').trim()
      if (summary) compactions.push({ time_ms: t, time: msToStr(t, timezone), compaction_id: String(d.compactionId || ''), summary })
      continue
    }
    if (type === 'user/message') {
      const kind = String(d.source?.kind || '').trim()
      if (SKIP_KINDS.has(kind)) { stats.system_skipped++; continue }
      const [texts, images] = blocks(d.content)
      let text = texts.join('\n').trim()
      if (!text && images.length) text = images.map(imagePlaceholder).join('\n')
      if (!text && !images.length) continue
      if (HUMAN_KINDS.has(kind) && isScaffold(text) && !images.length) { stats.scaffold_skipped++; continue }
      const role = HUMAN_KINDS.has(kind) ? 'user' : 'system'
      if (!currentRound || role === 'user' || SYSTEM_KINDS.has(kind)) {
        roundNo++
        currentRound = { index: roundNo, start_ms: t, date: localDate(t, timezone), items: [], has_human: role === 'user' }
        rounds.push(currentRound)
      }
      currentRound.items.push({ role, time_ms: t, text, source: kind, images })
      if (role === 'user') {
        currentRound.has_human = true
        stats.user_messages++
        stats.user_chars += text.length
        if (!firstAsk) firstAsk = text
      } else stats.system_messages++
      stats.images += images.length
      continue
    }
    if (type === 'assistant/message') {
      const msg = d.message || {}
      const [texts, images] = blocks(msg.content)
      const calls = []
      let reasoningChars = 0
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'reasoning') reasoningChars += String(b.text || '').length
        if (b.type === 'tool-call') {
          const callId = String(b.id || '')
          const name = String(b.name || '')
          let args = b.arguments
          if (typeof args !== 'string') args = JSON.stringify(args ?? {})
          calls.push({ id: callId, name, arguments: args })
          if (callId) {
            callNames.set(callId, name)
            if (!seenCalls.has(callId)) { seenCalls.add(callId); stats.tool_calls++ }
          }
        }
      }
      const text = texts.join('\n').trim()
      if (!text && !calls.length && !images.length) continue
      if (!currentRound) {
        roundNo++
        currentRound = { index: roundNo, start_ms: t, date: localDate(t, timezone), items: [], has_human: false }
        rounds.push(currentRound)
      }
      currentRound.items.push({ role: 'assistant', time_ms: t, text, tool_calls: calls, images, reasoning_chars: reasoningChars })
      stats.assistant_messages++
      stats.assistant_chars += text.length
      stats.reasoning_chars += reasoningChars
      stats.images += images.length
      continue
    }
    if (type === 'tool/call') {
      const callId = String(d.callId || '')
      const name = String(d.name || '')
      if (callId) {
        callNames.set(callId, name)
        if (!seenCalls.has(callId)) { seenCalls.add(callId); stats.tool_calls++ }
      }
      continue
    }
    if (type === 'tool/result') {
      const msg = d.message || {}
      const callId = String(d.toolCallId || msg.source?.callId || '')
      const [texts, images] = blocks(msg.content)
      const text = texts.join('\n')
      if (!text && !images.length) continue
      if (!currentRound) {
        roundNo++
        currentRound = { index: roundNo, start_ms: t, date: localDate(t, timezone), items: [], has_human: false }
        rounds.push(currentRound)
      }
      currentRound.items.push({
        role: 'tool', time_ms: t, text, images,
        tool_call_id: callId, tool_name: callNames.get(callId) || '',
      })
      stats.tool_results++
      stats.tool_result_chars += text.length
      stats.images += images.length
      continue
    }
  }

  const sessionId = String(header?.id || '')
  const short = sessionId.replace(/^session-/, '').split('-')[0].slice(0, 8) || 'unknown'
  return {
    path, header: header || {}, session_id: sessionId, session_short: short,
    cwd: String(header?.cwd || ''), created_ms: Number(header?.createdAt || 0),
    last_ms: lastMs, title, title_source: titleSource, first_ask: firstAsk,
    rounds, compactions, stats, event_types: typeCounter,
    event_dates: [...eventDates].sort(),
    notes: badLines ? [`坏 JSON 行：${badLines}`] : [],
    empty: rounds.length === 0,
  }
}

export async function parseSession(file, opts = {}) {
  const { text, notes, partial } = await readZstdText(file)
  const data = parseSessionEvents(text, { timezone: opts.timezone || 'local', path: file })
  data.notes.push(...notes)
  if (partial) data.notes.push('读取时文件尾部仍在写入，已保留完整事件')
  return data
}

export function sessionDates(data) {
  return [...new Set(data.rounds.map((r) => r.date))].sort()
}

export function lastEventDate(data) {
  return data.event_dates?.length ? data.event_dates[data.event_dates.length - 1] : ''
}

export function firstAskShort(data, n = 80) {
  return truncateChars(String(data.first_ask || '').trim(), n)
}
