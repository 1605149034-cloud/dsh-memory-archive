import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  archiveDir, backupDir, configPath, dshHome, loadConfig,
} from './config.mjs'
import { loadRecords } from './backup.mjs'
import { secretsStatus } from './secrets.mjs'
import { localDate, nowStr, readJson } from './util.mjs'

export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, min }
}

export function nextDaily(now = new Date(), at = '09:50') {
  const hm = parseHm(at)
  if (!hm) return null
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setHours(hm.h, hm.min, 0, 0)
  if (d <= now) d.setDate(d.getDate() + 1)
  return d
}

export function nextWeekly(now = new Date(), at = '10:10', weekday = 0) {
  const hm = parseHm(at)
  if (!hm) return null
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setHours(hm.h, hm.min, 0, 0)
  const delta = (Number(weekday) - d.getDay() + 7) % 7
  d.setDate(d.getDate() + delta)
  if (d <= now) d.setDate(d.getDate() + 7)
  return d
}

function countSlices(cfg) {
  const root = archiveDir(cfg)
  if (!existsSync(root)) return { dates: 0, slices: 0 }
  let dates = 0
  let slices = 0
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue
    dates++
    try {
      slices += readdirSync(join(root, d.name)).filter((f) => f.endsWith('.md') && f !== 'index.md').length
    } catch {}
  }
  return { dates, slices }
}

export async function getStatus(cfg = loadConfig({ create: false })) {
  const sc = await secretsStatus(cfg).catch(() => ({ configured: false, readable: false, encrypted: false, path: '' }))
  const { dates, slices } = countSlices(cfg)
  const records = loadRecords(cfg)
  const last = records.backups?.[records.backups.length - 1] || null
  const tags = readJson(join(archiveDir(cfg), 'tags.json'), { count: 0, tags: {} })
  const scan = readJson(join(archiveDir(cfg), 'state.json'), {})?.last_scan || null
  const nextD = nextDaily(new Date(), cfg.schedule?.dailyAt || '09:50')
  const nextW = nextWeekly(new Date(), cfg.schedule?.weeklyAt || '10:10', cfg.schedule?.weeklyDay ?? 0)
  const ready = !!(cfg.installed && sc.readable)
  return {
    ok: true,
    ready,
    installed: !!cfg.installed,
    configPath: configPath(),
    dshHome: dshHome(),
    paths: {
      archive: archiveDir(cfg),
      backup: backupDir(cfg),
      sessions: cfg.archive.sessionsDir,
    },
    archive: { dates, slices },
    tags: tags.count || 0,
    lastScan: scan,
    lastBackup: last ? {
      name: last.name, date: last.date, kind: last.kind, size: last.size,
      sha256: last.sha256, status: last.upload?.status || '',
      createdAt: last.createdAt,
    } : null,
    secrets: sc,
    uploader: {
      type: cfg.uploader.type,
      smtpHost: cfg.uploader.smtp.host || '',
      smtpUser: cfg.uploader.smtp.user ? `${cfg.uploader.smtp.user.slice(0, 3)}***` : '',
      webhook: cfg.uploader.webhook.url ? '(configured)' : '',
    },
    schedule: {
      enabled: !!cfg.schedule.enabled,
      dailyAt: cfg.schedule.dailyAt,
      weeklyAt: cfg.schedule.weeklyAt,
      nextDaily: nextD ? nextD.toISOString() : null,
      nextWeekly: nextW ? nextW.toISOString() : null,
    },
    now: nowStr(cfg.timezone),
    today: localDate(Date.now(), cfg.timezone),
  }
}

export function formatStatus(s) {
  const lines = [
    `dsh-memory-archive  status  ready=${s.ready ? 'YES' : 'NO'}`,
    `  归档目录: ${s.paths.archive}（${s.archive.dates} 天 / ${s.archive.slices} 个切片 / ${s.tags} 个标签）`,
    `  备份目录: ${s.paths.backup}`,
    `  会话来源: ${s.paths.sessions}`,
    `  上传通道: ${s.uploader.type}${s.uploader.smtpHost ? ` (${s.uploader.smtpHost}, ${s.uploader.smtpUser})` : ''}`,
    `  密钥库  : ${s.secrets.configured ? (s.secrets.encrypted ? '已配置（系统加密）' : '已配置（仅文件权限）') : '未配置'}`,
    `  定时    : ${s.schedule.enabled ? `每天 ${s.schedule.dailyAt} / 每周日 ${s.schedule.weeklyAt}` : '关闭'}`,
    `  最近扫描: ${s.lastScan?.at || '—'}`,
    `  最近备份: ${s.lastBackup ? `${s.lastBackup.name} (${s.lastBackup.status})` : '—'}`,
  ]
  return lines.join('\n')
}
