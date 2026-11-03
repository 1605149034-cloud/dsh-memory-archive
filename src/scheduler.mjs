import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveDir, loadConfig, logsDir } from './config.mjs'
import { scanAndArchive } from './archive.mjs'
import { rebuildIndex } from './indexer.mjs'
import { alert, backupNow } from './backup.mjs'
import { loadSecrets } from './secrets.mjs'
import { localDate, nowStr, readJson, writeJson } from './util.mjs'
import { nextDaily, nextWeekly, parseHm } from './status.mjs'

function stateFile(cfg) {
  return join(archiveDir(cfg), 'scheduler-state.json')
}

function lockFile(cfg) {
  return join(archiveDir(cfg), 'scheduler.lock')
}

function logLine(cfg, text) {
  try {
    mkdirSync(logsDir(cfg), { recursive: true })
    const f = join(logsDir(cfg), 'schedule.log')
    const prev = existsSync(f) ? readFileSync(f, 'utf8') : ''
    writeFileSync(f, prev + `- ${nowStr(cfg.timezone)} ${text}\n`, 'utf8')
  } catch {}
  console.log(`[schedule] ${text}`)
}

function due(cfg, state, now = new Date()) {
  if (!cfg.schedule?.enabled) return null
  const today = localDate(now.getTime(), cfg.timezone)
  const hm = parseHm(cfg.schedule.dailyAt)
  if (hm) {
    const scheduled = new Date(now)
    scheduled.setHours(hm.h, hm.min, 0, 0)
    const diff = now.getTime() - scheduled.getTime()
    if (diff >= 0 && diff < 2 * 3600_000 && state.lastDaily !== today) return 'daily'
  }
  const whm = parseHm(cfg.schedule.weeklyAt)
  if (whm && Number(cfg.schedule.weeklyDay ?? 0) === now.getDay()) {
    const scheduled = new Date(now)
    scheduled.setHours(whm.h, whm.min, 0, 0)
    const diff = now.getTime() - scheduled.getTime()
    if (diff >= 0 && diff < 2 * 3600_000 && state.lastWeekly !== today) return 'weekly'
  }
  return null
}

async function runOne(cfg, kind) {
  logLine(cfg, `trigger ${kind}`)
  const lock = lockFile(cfg)
  try {
    if (existsSync(lock)) {
      const st = readJson(lock, {})
      if (st.at && Date.now() - new Date(st.at).getTime() < 2 * 3600_000) {
        logLine(cfg, `skip ${kind}: another run in progress`)
        return false
      }
    }
    writeJson(lock, { pid: process.pid, at: new Date().toISOString(), kind })
    const s = await scanAndArchive(cfg, { mode: cfg.archive.mode })
    const idx = rebuildIndex(cfg)
    const secrets = (await loadSecrets(cfg)).secrets
    if (!secrets) throw new Error('密钥库不可读，无法备份')
    const rec = await backupNow(cfg, secrets, { kind, upload: cfg.uploader.type !== 'local_only' })
    logLine(cfg, `done ${kind}: scan processed=${s.stats.processed} slices=${idx.entries} backup=${rec.name} upload=${rec.upload?.status}`)
    return true
  } catch (e) {
    logLine(cfg, `FAILED ${kind}: ${e.message}`)
    alert(cfg, `定时 ${kind} 失败：${e.message}`)
    return false
  } finally {
    try { if (existsSync(lock)) unlinkSync(lock) } catch {}
  }
}

export function startScheduler(cfg, { immediateCheckMs = 5000 } = {}) {
  if (!cfg?.installed || !cfg?.schedule?.enabled) {
    return { enabled: false, stop() {} }
  }
  const state = readJson(stateFile(cfg), { lastDaily: '', lastWeekly: '' })
  let running = false
  let timer = null
  let kick = null
  const check = async () => {
    if (running) return
    const kind = due(cfg, state)
    if (!kind) return
    running = true
    try {
      const ok = await runOne(cfg, kind)
      if (ok) {
        const today = localDate(Date.now(), cfg.timezone)
        if (kind === 'daily') state.lastDaily = today
        if (kind === 'weekly') state.lastWeekly = today
        writeJson(stateFile(cfg), state)
      }
    } finally {
      running = false
    }
  }
  kick = setTimeout(check, immediateCheckMs)
  timer = setInterval(check, 30_000)
  if (timer.unref) timer.unref()
  logLine(cfg, `scheduler on：daily=${cfg.schedule.dailyAt} weekly=${cfg.schedule.weeklyAt} day=${cfg.schedule.weeklyDay}`)
  return {
    enabled: true,
    stop() {
      if (timer) clearInterval(timer)
      if (kick) clearTimeout(kick)
      timer = null
      kick = null
    },
    next: () => ({
      daily: nextDaily(new Date(), cfg.schedule.dailyAt)?.toISOString(),
      weekly: nextWeekly(new Date(), cfg.schedule.weeklyAt, cfg.schedule.weeklyDay ?? 0)?.toISOString(),
    }),
  }
}
