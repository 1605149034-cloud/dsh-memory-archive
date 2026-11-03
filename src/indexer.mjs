import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { archiveDir, indexFilePath, tagsFilePath } from './config.mjs'
import { nowStr, readFrontMatter, writeTextIfChanged } from './util.mjs'

function listDateDirs(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
}

function listify(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return []
}

function cell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function link(label, target) {
  return target.includes(' ') || /[()]/.test(target) ? `[${label}](<${target}>)` : `[${label}](${target})`
}

export function collectEntries(cfg) {
  const root = archiveDir(cfg)
  const entries = []
  for (const date of listDateDirs(root)) {
    const dir = join(root, date)
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md').sort()) {
      const file = join(dir, name)
      const [meta] = readFrontMatter(file)
      if (!meta || !meta.session) continue
      entries.push({
        date: String(meta.date || date),
        workspace: String(meta.workspace || ''),
        session: String(meta.session || ''),
        session_id: String(meta.session_id || ''),
        title: String(meta.title || ''),
        first_ask: String(meta.first_ask || ''),
        turns: Number(meta.turns || 0),
        session_turns: Number(meta.session_turns || 0),
        tags: listify(meta.tags),
        keywords: listify(meta.keywords),
        file,
        rel_path: `${date}/${name}`,
      })
    }
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.workspace.localeCompare(b.workspace) || a.session.localeCompare(b.session))
  return entries
}

function table(entries, forDay) {
  const lines = [
    '| 工作区 | 会话 | 主题 | 轮次 | 标签 | 关键词 | 文件 |',
    '|---|---|---|---:|---|---|---|',
  ]
  for (const e of entries) {
    const topic = e.title || e.first_ask || ''
    lines.push(
      `| ${cell(e.workspace)} | ${cell(e.session)} | ${cell(topic)} | ${e.turns} | ` +
      `${cell(e.tags.join('、'))} | ${cell(e.keywords.join('、'))} | ` +
      `${link(e.file.split(/[\\/]/).pop(), forDay ? e.file.split(/[\\/]/).pop() : e.rel_path)} |`
    )
  }
  return lines
}

export function rebuildIndex(cfg) {
  const root = archiveDir(cfg)
  const entries = collectEntries(cfg)
  const byDate = new Map()
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, [])
    byDate.get(e.date).push(e)
  }

  const lines = [
    '# 会话记忆库 · 总目录',
    '',
    `> 生成时间：${nowStr(cfg.timezone)} ｜ 日期：${byDate.size} 天 ｜ 日切片：${entries.length} 个`,
    `> 数据目录：\`${root}\` ｜ 会话只读来源：\`${cfg.archive.sessionsDir}\``,
    '',
  ]
  if (!entries.length) lines.push('（暂无归档。先运行 `dsh-memory-archive archive --backfill 30`。）')
  for (const date of [...byDate.keys()].sort().reverse()) {
    lines.push(`## ${date}（${byDate.get(date).length} 个切片）`)
    lines.push('')
    lines.push(...table(byDate.get(date), false))
    lines.push('')
  }
  writeTextIfChanged(indexFilePath(cfg), lines.join('\n').replace(/\s+$/, '') + '\n')

  for (const [date, group] of byDate.entries()) {
    const dir = join(root, date)
    const day = [
      `# ${date} · 会话目录`,
      '',
      `> 本日切片：${group.length} 个 ｜ 生成时间：${nowStr(cfg.timezone)}`,
      '> 返回：[总目录](../index.md)',
      '',
      ...table(group, true),
      '',
    ]
    writeTextIfChanged(join(dir, 'index.md'), day.join('\n').replace(/\s+$/, '') + '\n')
  }

  const tags = {}
  for (const e of entries) {
    for (const tag of e.tags) {
      if (!tags[tag]) tags[tag] = { count: 0, dates: [], sessions: [] }
      tags[tag].count++
      if (!tags[tag].dates.includes(e.date)) tags[tag].dates.push(e.date)
      tags[tag].sessions.push({
        date: e.date, workspace: e.workspace, session: e.session,
        title: e.title, path: e.rel_path, turns: e.turns,
      })
    }
  }
  for (const t of Object.values(tags)) {
    t.dates.sort().reverse()
    t.sessions.sort((a, b) => b.date.localeCompare(a.date))
  }
  const ordered = Object.fromEntries(Object.entries(tags).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])))
  writeTextIfChanged(tagsFilePath(cfg), JSON.stringify({
    generated_at: nowStr(cfg.timezone), count: Object.keys(ordered).length, tags: ordered,
  }, null, 2) + '\n')

  return { entries: entries.length, dates: byDate.size, tags: Object.keys(ordered).length }
}
