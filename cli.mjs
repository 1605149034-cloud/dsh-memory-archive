#!/usr/bin/env node
/**
 * dsh-memory-archive CLI
 * 命令：init / archive / backup / search / read / status / selftest / doctor / cleanup
 */
import { parseArgs } from 'node:util'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  archiveDir, backupDir, configDir, configPath, dshHome, loadConfig,
} from './src/config.mjs'
import { scanAndArchive, printScanSummary } from './src/archive.mjs'
import { rebuildIndex } from './src/indexer.mjs'
import { backupNow } from './src/backup.mjs'
import { loadSecrets, secretsStatus } from './src/secrets.mjs'
import { search, formatResults, readRange } from './src/search.mjs'
import { getStatus, formatStatus } from './src/status.mjs'
import { runInit } from './src/wizard.mjs'
import { runSelftest } from './src/selftest.mjs'

const VERSION = '0.1.0'

function help() {
  console.log(`dsh-memory-archive ${VERSION}

用法：
  dsh-memory-archive init [选项]              首次运行向导（选范围/模式/邮箱/授权码/密码 + 健康检查）
  dsh-memory-archive archive [--backfill 30]  归档会话（默认今天有变动的）
  dsh-memory-archive backup [--kind daily]    加密备份并上传
  dsh-memory-archive search --tag 标签         检索（返回目录项+路径+片段）
  dsh-memory-archive read --file <路径> --from 1 --to 5
  dsh-memory-archive status [--json]           查看状态
  dsh-memory-archive selftest [--check-upload] 自测；--offline 跳过网络
  dsh-memory-archive doctor                    环境体检
  dsh-memory-archive cleanup [--purge --yes]   清理配置/密钥（默认只打印，不删）

init 非交互示例（密钥只从环境变量读，不落 argv）：
  DMA_BACKUP_PASSWORD=... DMA_SMTP_PASSWORD=... \\
  dsh-memory-archive init --non-interactive --uploader smtp \\
    --smtp-host smtp.qq.com --smtp-port 465 --smtp-user me@qq.com --smtp-to me@qq.com

环境变量：
  DSH_HOME                     DSH 数据根，默认 ~/.dsh
  DSH_MEMORY_ARCHIVE_HOME      配置目录（测试用），默认 $DSH_HOME/memory-archive
  DMA_SMTP_PASSWORD            SMTP 授权码/应用密码（仅非交互 init）
  DMA_BACKUP_PASSWORD          备份密码（仅非交互 init）
  DMA_WEBHOOK_TOKEN            Webhook token（可选）
`)
}

function fail(e) {
  console.error(`[FAIL] ${e?.name || 'Error'}: ${e?.message || e}`)
  process.exitCode = 1
}

function loadReadyConfig() {
  if (!existsSync(configPath())) throw new Error('尚未初始化：先运行 dsh-memory-archive init')
  const cfg = loadConfig({ create: false })
  if (!cfg.installed) throw new Error('配置存在但尚未完成健康检查：重新运行 dsh-memory-archive init')
  return cfg
}

async function cmdInit(values) {
  const r = await runInit({
    nonInteractive: !!values['non-interactive'] || !process.stdin.isTTY,
    scope: values.scope,
    workspaces: values.workspaces,
    mode: values.mode,
    uploader: values.uploader,
    archiveDir: values['archive-dir'],
    backupDir: values['backup-dir'],
    sessionsDir: values['sessions-dir'],
    smtpHost: values['smtp-host'],
    smtpPort: values['smtp-port'],
    smtpUser: values['smtp-user'],
    smtpTo: values['smtp-to'],
    imapHost: values['imap-host'],
    imapPort: values['imap-port'],
    webhookUrl: values['webhook-url'],
    noHealth: !!values['no-health'],
  })
  if (!r.ok) process.exitCode = 1
}

async function cmdArchive(values) {
  const cfg = loadConfig({ create: false })
  const backfill = values.backfill !== undefined ? Number(values.backfill) : null
  const summary = await scanAndArchive(cfg, {
    targetDate: values.date || null,
    backfillDays: backfill,
    mode: values.mode || null,
    verbose: !!values.verbose,
    dryRun: !!values['dry-run'],
  })
  printScanSummary(summary)
  if (!values['dry-run']) {
    const idx = rebuildIndex(cfg)
    console.log(`[index] 日切片 ${idx.entries} 个，日期 ${idx.dates} 天，标签 ${idx.tags} 个`)
    console.log(`[index] ${join(archiveDir(cfg), 'index.md')}`)
  }
}

async function cmdBackup(values) {
  const cfg = loadReadyConfig()
  const { secrets } = await loadSecrets(cfg)
  if (!secrets) throw new Error('密钥库不可读，请重新 init')
  const rec = await backupNow(cfg, secrets, {
    kind: values.kind === 'weekly' ? 'weekly' : 'daily',
    date: values.date || null,
    upload: !values['no-upload'],
  })
  console.log(JSON.stringify({
    name: rec.name, path: rec.path, size: rec.size, sha256: rec.sha256,
    parts: rec.parts, upload: rec.upload,
  }, null, 2))
}

function cmdSearch(values) {
  const cfg = loadReadyConfig()
  const results = search(cfg, {
    tag: values.tag || null, keyword: values.keyword || null,
    date: values.date || null, since: values.since || null, until: values.until || null,
    workspace: values.workspace || null, limit: Number(values.limit || 10),
    regex: !!values.regex, deep: !!values.deep,
  })
  if (values.json) console.log(JSON.stringify(results, null, 2))
  else console.log(formatResults(results))
  if (!results.length) process.exitCode = 2
}

function cmdRead(values) {
  const cfg = loadReadyConfig()
  if (!values.file) throw new Error('缺少 --file')
  const from = Number(values.from || 0)
  const to = Number(values.to || from)
  if (!from || !to || to < from) throw new Error('--from / --to 必须是正整数且 from <= to')
  console.log(readRange(cfg, values.file, from, to))
}

async function cmdStatus(values) {
  const cfg = loadConfig({ create: false })
  const s = await getStatus(cfg)
  if (values.json) console.log(JSON.stringify(s, null, 2))
  else console.log(formatStatus(s))
}

async function cmdSelftest(values) {
  const cfg = loadConfig({ create: false })
  const r = await runSelftest(cfg, {
    offline: !!values.offline,
    checkUpload: !!values['check-upload'],
  })
  if (!r.ok) process.exitCode = 1
}

async function cmdDoctor() {
  const checks = []
  const add = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`) }
  add('Node >= 22.15', (() => { const [a, b] = process.versions.node.split('.').map(Number); return a > 22 || (a === 22 && b >= 15) })(), process.version)
  for (const dep of ['@zip.js/zip.js', 'nodemailer', 'imapflow', 'mailparser']) {
    try { await import(dep); add(dep, true) } catch (e) { add(dep, false, e.message) }
  }
  add('DSH_HOME', !!dshHome(), dshHome())
  add('config.json', existsSync(configPath()), configPath())
  add('sessions 目录', existsSync(loadConfig({ create: false }).archive.sessionsDir), loadConfig({ create: false }).archive.sessionsDir)
  try {
    const cfg = loadConfig({ create: false })
    const st = await secretsStatus(cfg)
    add('密钥库', st.readable, st.configured ? (st.encrypted ? '系统加密' : '仅文件权限') : '未配置')
    add('归档目录', existsSync(archiveDir(cfg)), archiveDir(cfg))
    add('备份目录', existsSync(backupDir(cfg)), backupDir(cfg))
  } catch (e) { add('配置读取', false, e.message) }
  if (checks.some((c) => !c.ok)) process.exitCode = 1
}

async function cmdCleanup(values) {
  const cfg = loadConfig({ create: false })
  const dirs = [...new Set([archiveDir(cfg), backupDir(cfg), configDir(cfg)])]
  console.log('将清理以下目录（不含系统计划任务；本插件不使用系统计划任务）：')
  for (const d of dirs) console.log(`  ${d}`)
  if (!values.purge) { console.log('（只打印；真要删除请加 --purge --yes）'); return }
  if (!values.yes) throw new Error('--purge 需要同时加 --yes 确认')
  for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  console.log('[OK] 已删除配置、密钥与本地归档。')
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') { help(); return }
  if (args[0] === '-v' || args[0] === '--version') { console.log(VERSION); return }
  if (args.includes('--help') || args.includes('-h')) { help(); return }
  const cmd = args[0]
  const { values } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      'non-interactive': { type: 'boolean' }, scope: { type: 'string' }, workspaces: { type: 'string' },
      mode: { type: 'string' }, uploader: { type: 'string' }, 'archive-dir': { type: 'string' },
      'backup-dir': { type: 'string' }, 'sessions-dir': { type: 'string' },
      'smtp-host': { type: 'string' }, 'smtp-port': { type: 'string' }, 'smtp-user': { type: 'string' },
      'smtp-to': { type: 'string' }, 'imap-host': { type: 'string' }, 'imap-port': { type: 'string' },
      'webhook-url': { type: 'string' }, 'no-health': { type: 'boolean' },
      backfill: { type: 'string' }, date: { type: 'string' }, verbose: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      kind: { type: 'string' }, 'no-upload': { type: 'boolean' }, 'no-verify': { type: 'boolean' },
      tag: { type: 'string' }, keyword: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
      workspace: { type: 'string' }, limit: { type: 'string' }, regex: { type: 'boolean' }, deep: { type: 'boolean' }, json: { type: 'boolean' },
      file: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      offline: { type: 'boolean' }, 'check-upload': { type: 'boolean' }, purge: { type: 'boolean' }, yes: { type: 'boolean' },
    },
  })
  switch (cmd) {
    case 'init': return cmdInit(values)
    case 'archive': return cmdArchive(values)
    case 'backup': return cmdBackup(values)
    case 'search': return cmdSearch(values)
    case 'read': return cmdRead(values)
    case 'status': return cmdStatus(values)
    case 'selftest': return cmdSelftest(values)
    case 'doctor': return cmdDoctor()
    case 'cleanup': return cmdCleanup(values)
    default: help(); process.exitCode = 1
  }
}

main().catch(fail)
