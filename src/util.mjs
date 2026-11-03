import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const TZ = process.env.DSH_MEMORY_ARCHIVE_TZ || 'local'

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function sha256File(file) {
  return sha256Buffer(readFileSync(file))
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value, { pretty = true } = {}) {
  ensureDir(dirname(file))
  const text = JSON.stringify(value, null, pretty ? 2 : 0) + '\n'
  writeFileSync(file, text, 'utf8')
}

export function writeTextIfChanged(file, text) {
  const buf = Buffer.from(String(text), 'utf8')
  if (existsSync(file)) {
    try {
      if (readFileSync(file).equals(buf)) return false
    } catch {}
  }
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, buf)
  renameSync(tmp, file)
  return true
}

export function writeBufferIfChanged(file, buf) {
  if (existsSync(file)) {
    try {
      if (readFileSync(file).equals(buf)) return false
    } catch {}
  }
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, buf)
  renameSync(tmp, file)
  return true
}

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return process.env.HOME || process.env.USERPROFILE || p
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2))
  }
  return p
}

export function localParts(ms = Date.now(), timeZone = TZ) {
  const d = new Date(Number(ms) || 0)
  if (!timeZone || timeZone === 'local') {
    return {
      y: d.getFullYear(),
      m: String(d.getMonth() + 1).padStart(2, '0'),
      d: String(d.getDate()).padStart(2, '0'),
      hh: String(d.getHours()).padStart(2, '0'),
      mm: String(d.getMinutes()).padStart(2, '0'),
      ss: String(d.getSeconds()).padStart(2, '0'),
    }
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]))
  return { y: parts.year, m: parts.month, d: parts.day, hh: parts.hour, mm: parts.minute, ss: parts.second }
}

export function localDate(ms = Date.now(), timeZone = TZ) {
  const p = localParts(ms, timeZone)
  return `${p.y}-${p.m}-${p.d}`
}

export function msToStr(ms = Date.now(), timeZone = TZ) {
  const p = localParts(ms, timeZone)
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`
}

export function nowStr(timeZone = TZ) {
  return msToStr(Date.now(), timeZone)
}

export function truncateBytes(text, limit) {
  const s = String(text ?? '')
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= limit) return [s, 0]
  let cut = buf.subarray(0, limit)
  let out = ''
  while (cut.length) {
    try {
      out = new TextDecoder('utf-8', { fatal: true }).decode(cut)
      break
    } catch {
      cut = cut.subarray(0, cut.length - 1)
    }
  }
  return [out, buf.length - cut.length]
}

export function truncateChars(text, limit) {
  const s = String(text ?? '')
  return s.length <= limit ? s : s.slice(0, Math.max(0, limit - 1)) + '…'
}

export function cleanInline(text, limit = 200) {
  return truncateChars(String(text ?? '').replace(/\s+/g, ' ').trim(), limit)
}

export function sanitizeName(name) {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
  return s || '未命名'
}

export function relPosix(base, target) {
  return resolve(target).slice(resolve(base).length + 1).split('\\').join('/')
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function retry(fn, { attempts = 5, baseMs = 800, factor = 2, maxMs = 20000, onRetry } = {}) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i)
    } catch (e) {
      last = e
      if (i === attempts) break
      const wait = Math.min(maxMs, baseMs * Math.pow(factor, i - 1))
      if (onRetry) onRetry(i, wait, e)
      await sleep(wait)
    }
  }
  throw last
}

export function frontMatterDump(meta, order = []) {
  const keys = [...order.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !order.includes(k))]
  const lines = ['---']
  for (const k of keys) lines.push(`${k}: ${JSON.stringify(meta[k])}`)
  lines.push('---')
  return lines.join('\n')
}

export function readFrontMatter(file, maxBytes = 65536) {
  let text = ''
  try {
    const buf = readFileSync(file)
    text = buf.subarray(0, maxBytes).toString('utf8')
  } catch {
    return [{}, '']
  }
  if (!text.startsWith('---')) return [{}, text]
  const end = text.indexOf('\n---', 3)
  if (end < 0) return [{}, text]
  const block = text.slice(3, end).trim()
  const body = text.slice(end + 4)
  const meta = {}
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    try { meta[k] = JSON.parse(v) } catch { meta[k] = v }
  }
  return [meta, body]
}

export function fileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}
