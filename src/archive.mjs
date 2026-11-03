import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  loadTagRules, resolveWorkspace, statePath, workspaceAllowed,
} from './config.mjs'
import { lastEventDate, parseSession } from './session.mjs'
import { buildMeta, writeSlice } from './render.mjs'
import { buildTags, keywordsForSlices, tagTextForRounds } from './tags.mjs'
import {
  localDate, nowStr, readJson, sha256File, writeJson,
} from './util.mjs'

function loadState(cfg) {
  const st = readJson(statePath(cfg), null)
  if (!st || typeof st !== 'object') return { version: 1, sessions: {} }
  if (!st.sessions || typeof st.sessions !== 'object') st.sessions = {}
  st.version = st.version || 1
  return st
}

function cutoffDate(target, days) {
  const d = new Date(`${target}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export async function scanAndArchive(cfg, {
  targetDate = null,
  backfillDays = null,
  mode = null,
  verbose = false,
  dryRun = false,
} = {}) {
  const target = targetDate || localDate(Date.now(), cfg.timezone)
  const modeUsed = mode || cfg.archive.mode || 'incremental'
  const state = loadState(cfg)
  const firstRun = Object.keys(state.sessions || {}).length === 0
  const fullScan = modeUsed === 'full' || firstRun || backfillDays != null
  const cutoff = backfillDays != null ? cutoffDate(target, backfillDays) : null
  const rules = loadTagRules(cfg)
  const stats = {
    scanned: 0, processed: 0, skipped_unchanged: 0, skipped_hash: 0,
    skipped_not_today: 0, skipped_empty: 0, skipped_old: 0,
    skipped_no_file: 0, skipped_scope: 0, skipped_stat_error: 0,
    written_files: 0, slices: 0, total_sessions: 0,
  }
  const details = []

  const sessionsDir = cfg.archive.sessionsDir
  if (!existsSync(sessionsDir)) throw new Error(`sessions 目录不存在：${sessionsDir}`)
  if (verbose) console.log(`[scan] target=${target} mode=${modeUsed} full=${fullScan} cutoff=${cutoff || '-'}`)

  const workspaceDirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const wd of workspaceDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const wdPath = join(sessionsDir, wd.name)
    let sessionDirs = []
    try { sessionDirs = readdirSync(wdPath, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const sd of sessionDirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const sdPath = join(wdPath, sd.name)
      let files = []
      try { files = readdirSync(sdPath).filter((f) => f.endsWith('.zstd')) } catch { continue }
      if (!files.length) { stats.skipped_no_file++; continue }
      const zfile = join(sdPath, files.sort()[0])
      stats.total_sessions++
      const rel = relative(sessionsDir, zfile).split('\\').join('/')
      let st
      try { st = statSync(zfile) } catch { stats.skipped_stat_error++; continue }
      const entry = state.sessions[rel]
      const mtimeDate = localDate(st.mtimeMs, cfg.timezone)

      if (!fullScan && entry) {
        if (entry.size === st.size && entry.mtime_ns === Math.trunc(st.mtimeMs * 1e6)) {
          stats.skipped_unchanged++
          if (verbose) console.log(`SKIP unchanged ${rel}`)
          continue
        }
        const last = entry.last_event_date || ''
        if (last && last < target && mtimeDate < target) {
          stats.skipped_not_today++
          if (verbose) console.log(`SKIP not-today ${rel} last=${last}`)
          continue
        }
      }

      let data
      try {
        data = await parseSession(zfile, { timezone: cfg.timezone })
      } catch (e) {
        stats.skipped_stat_error++
        if (verbose) console.log(`SKIP parse-error ${rel}: ${e.message}`)
        continue
      }
      stats.scanned++
      const sha = sha256File(zfile)
      const mtimeNs = Math.trunc(st.mtimeMs * 1e6)

      if (data.empty) {
        stats.skipped_empty++
        state.sessions[rel] = {
          session_id: data.session_id, size: st.size, mtime_ns: mtimeNs, sha256: sha,
          last_event_ms: data.last_ms, last_event_date: '', empty: true,
          last_processed_at: nowStr(cfg.timezone),
        }
        if (verbose) console.log(`SKIP empty ${rel}`)
        continue
      }
      const lastDate = lastEventDate(data)
      if (cutoff && lastDate < cutoff) {
        stats.skipped_old++
        if (verbose) console.log(`SKIP before-cutoff ${rel} last=${lastDate}`)
        continue
      }
      if (!fullScan && !data.event_dates.includes(target)) {
        stats.skipped_not_today++
        if (verbose) console.log(`SKIP no-events-today ${rel}`)
        continue
      }
      if (entry && entry.sha256 === sha && !fullScan) {
        entry.size = st.size
        entry.mtime_ns = mtimeNs
        entry.last_event_ms = data.last_ms
        entry.last_event_date = lastDate
        stats.skipped_hash++
        if (verbose) console.log(`SKIP hash-same ${rel}`)
        continue
      }

      const workspace = resolveWorkspace(cfg, data.cwd, data.session_id)
      if (!workspaceAllowed(cfg, workspace)) {
        stats.skipped_scope++
        if (verbose) console.log(`SKIP scope ${rel} ws=${workspace}`)
        continue
      }

      const byDate = new Map()
      for (const r of data.rounds) {
        if (cutoff && r.date < cutoff) continue
        if (!byDate.has(r.date)) byDate.set(r.date, [])
        byDate.get(r.date).push(r)
      }
      const dates = [...byDate.keys()].sort()
      const texts = dates.map((d) => tagTextForRounds(data, byDate.get(d)))
      const keywordLists = keywordsForSlices(texts, 8)
      const slices = {}
      let changedFiles = 0
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i]
        const rounds = byDate.get(date)
        const kw = keywordLists[i] || []
        const tags = buildTags(texts[i], workspace, rules, kw)
        const meta = buildMeta(cfg, data, date, rounds, workspace, tags, kw)
        if (dryRun) {
          changedFiles += 2
          slices[date] = { md: '', json: '', turns: rounds.length, md_changed: true }
        } else {
          const p = writeSlice(cfg, data, date, rounds, meta)
          changedFiles += (p.mdChanged ? 1 : 0) + (p.jsonChanged ? 1 : 0)
          slices[date] = { md: p.md, json: p.json, turns: rounds.length, md_changed: !!p.mdChanged }
        }
      }
      stats.processed++
      stats.written_files += changedFiles
      stats.slices += dates.length
      state.sessions[rel] = {
        session_id: data.session_id,
        workspace,
        title: data.title || '',
        first_ask: data.first_ask ? data.first_ask.slice(0, 80) : '',
        size: st.size,
        mtime_ns: mtimeNs,
        sha256: sha,
        last_event_ms: data.last_ms,
        last_event_date: lastDate,
        session_turns: data.rounds.length,
        empty: false,
        slices,
        last_processed_at: nowStr(cfg.timezone),
      }
      details.push({ rel, workspace, session: data.session_short, title: data.title, dates, turns: data.rounds.length, changedFiles })
      if (verbose) console.log(`OK ${rel} ws=${workspace} dates=${dates.join(',')} turns=${data.rounds.length} changed=${changedFiles}`)
    }
  }

  const summary = { target_date: target, mode: modeUsed, full_scan: fullScan, backfill_days: backfillDays, stats, details }
  if (!dryRun) {
    state.last_scan = { at: nowStr(cfg.timezone), target_date: target, mode: modeUsed, stats }
    writeJson(statePath(cfg), state)
  }
  return summary
}

export function printScanSummary(summary) {
  const s = summary.stats
  console.log(
    `[scan] 会话总数 ${s.total_sessions}：处理 ${s.processed}，未变化跳过 ${s.skipped_unchanged}，` +
    `hash 相同跳过 ${s.skipped_hash}，非目标日跳过 ${s.skipped_not_today}，空会话 ${s.skipped_empty}，` +
    `过期跳过 ${s.skipped_old}，范围外 ${s.skipped_scope}，写入文件 ${s.written_files} 个（${s.slices} 个日切片）`
  )
}
