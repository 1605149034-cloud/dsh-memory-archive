import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  archiveDir, backupDir, logsDir, statePath, tagsFilePath, indexFilePath, tagRulesPath, configPath,
} from './config.mjs'
import { createEncryptedZip, verifyEncryptedZip } from './archive-crypto.mjs'
import { createUploader } from './uploaders/index.mjs'
import {
  ensureDir, fileSize, localDate, nowStr, readJson, sha256File, writeJson,
} from './util.mjs'

const ROOT_FILES = ['index.md', 'tags.json', 'state.json', 'config.json', 'tag_rules.json']

export function recordPath(cfg) {
  return join(backupDir(cfg), 'backups.json')
}

export function loadRecords(cfg) {
  const r = readJson(recordPath(cfg), null)
  if (!r || typeof r !== 'object') return { version: 1, backups: [] }
  if (!Array.isArray(r.backups)) r.backups = []
  return r
}

export function saveRecords(cfg, rec) {
  rec.updated_at = nowStr(cfg.timezone)
  writeJson(recordPath(cfg), rec)
}

function dateDirs(cfg) {
  const root = archiveDir(cfg)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
}

function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

export function collectBackupFiles(cfg, date, kind) {
  const files = []
  for (const f of ROOT_FILES) {
    const p = join(archiveDir(cfg), f)
    if (existsSync(p)) files.push(p)
  }
  const dirs = dateDirs(cfg)
  if (kind === 'weekly') {
    for (const d of dirs) files.push(...filesUnder(join(archiveDir(cfg), d)))
    return files
  }
  const firstBackup = !existsSync(recordPath(cfg))
  if (firstBackup) {
    for (const d of dirs) files.push(...filesUnder(join(archiveDir(cfg), d)))
    return files
  }
  for (const d of dirs) {
    const dir = join(archiveDir(cfg), d)
    const all = filesUnder(dir)
    if (d === date) { files.push(...all); continue }
    for (const p of all) {
      const mdate = localDate(statSync(p).mtimeMs, cfg.timezone)
      if (mdate === date) files.push(p)
    }
  }
  return files
}

export function splitFile(file, maxBytes) {
  const size = fileSize(file)
  if (size <= maxBytes) return [file]
  const total = Math.ceil(size / maxBytes)
  const name = file.split(/[\\/]/).pop()
  const stem = name.replace(/\.zip$/i, '')
  const dir = dirname(file)
  const parts = []
  const buf = readFileSync(file)
  for (let i = 0; i < total; i++) {
    const partName = `${stem}-part${String(i + 1).padStart(2, '0')}of${String(total).padStart(2, '0')}.zip.${String(i + 1).padStart(3, '0')}`
    const partPath = join(dir, partName)
    writeFileSync(partPath, buf.subarray(i * maxBytes, Math.min(size, (i + 1) * maxBytes)))
    parts.push(partPath)
  }
  return parts
}

export function alert(cfg, text) {
  const line = `- ${nowStr(cfg.timezone)} [dsh-memory-archive] ${text}`
  try {
    ensureDir(logsDir(cfg))
    const f = join(logsDir(cfg), 'alerts.log')
    const prev = existsSync(f) ? readFileSync(f, 'utf8') : ''
    writeFileSync(f, prev + line + '\n', 'utf8')
  } catch {}
  console.error(`[ALERT] ${text}`)
}

export async function createBackup(cfg, { kind = 'daily', date = null } = {}) {
  const d = date || localDate(Date.now(), cfg.timezone)
  const files = collectBackupFiles(cfg, d, kind)
  if (!files.length) throw new Error('没有可备份的文件：先运行 archive')
  const iso = new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)
  let name
  if (kind === 'weekly') {
    const dt = new Date(`${iso}T00:00:00Z`)
    const day = dt.getUTCDay() || 7
    const thursday = new Date(dt)
    thursday.setUTCDate(dt.getUTCDate() + 4 - day)
    const year = thursday.getUTCFullYear()
    const week = Math.ceil((((thursday - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7)
    name = `${year}-W${String(week).padStart(2, '0')}-full.zip`
  } else {
    name = `${d}.zip`
  }
  const out = join(backupDir(cfg), name)
  ensureDir(dirname(out))
  return { out, files, name, date: d, kind }
}

export async function backupNow(cfg, secrets, {
  kind = 'daily', date = null, upload = true, verify = true,
} = {}) {
  const password = secrets?.backupPassword
  if (!password || password.length < 8) throw new Error('备份密码未配置或太短')
  const { out, files, name, date: d } = await createBackup(cfg, { kind, date })
  const meta = {
    kind, date: d, name, path: out,
    files: files.length,
    createdAt: nowStr(cfg.timezone),
    sha256: '', size: 0, parts: [], upload: { status: 'skipped' },
  }
  try {
    await createEncryptedZip(files.map((p) => ({
      path: p,
      arcname: p.slice(archiveDir(cfg).length + 1).split('\\').join('/'),
    })), out, password)
    await verifyEncryptedZip(out, password)
    meta.sha256 = sha256File(out)
    meta.size = fileSize(out)
    const maxBytes = Math.max(1, Number(cfg.backup.maxAttachmentMB || 50)) * 1024 * 1024
    const parts = splitFile(out, maxBytes)
    meta.parts = parts.map((p) => p.split(/[\\/]/).pop())
    const sidecar = `${out}.sha256`
    writeFileSync(sidecar, `${meta.sha256}  ${name}\n`, 'utf8')

    if (!upload) {
      const rec = loadRecords(cfg)
      rec.backups = rec.backups.filter((b) => b.name !== name)
      rec.backups.push(meta)
      saveRecords(cfg, rec)
      return meta
    }

    const uploader = await createUploader(cfg, secrets)
    const token = `dma-${d}-${randomBytes(4).toString('hex')}`
    const sendResults = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const partName = part.split(/[\\/]/).pop()
      const r = await uploader.send({
        filePath: part,
        partName,
        partIndex: i + 1,
        totalParts: parts.length,
        date: d,
        kind,
        token,
        sha256: meta.sha256,
        wholeSize: meta.size,
        backupDir: backupDir(cfg),
      })
      sendResults.push(r)
    }
    let vr
    if (uploader.type === 'smtp') {
      vr = verify
        ? await uploader.verify({ token, expectedSha256: meta.sha256, expectedNames: meta.parts })
        : { status: 'sent' }
    } else if (uploader.type === 'webhook') {
      const remote = sendResults.map((r) => r.remoteSha256).filter(Boolean)
      if (remote.length && remote.every((x) => x === meta.sha256)) {
        vr = { status: 'verified', downloadSha256: meta.sha256, parts: [] }
      } else {
        vr = { status: 'sent', error: remote.length ? 'webhook 返回 sha256 不一致' : 'webhook 未返回 sha256' }
      }
    } else {
      vr = await uploader.verify({ expectedSha256: meta.sha256, expectedNames: meta.parts, backupDir: backupDir(cfg) })
    }
    meta.upload = {
      type: uploader.type, token, status: vr.status,
      messageIds: sendResults.map((r) => r.messageId).filter(Boolean),
      downloadSha256: vr.downloadSha256 || '',
      error: vr.error || '',
      parts: meta.parts,
    }
    if (vr.status === 'failed') throw new Error(vr.error || '上传后校验失败')
    if (vr.status === 'sent') {
      alert(cfg, `${name} 已发送但未完成回取校验（${vr.error || '通道未返回可校验信息'}）`)
    }
  } catch (e) {
    meta.upload = { ...(meta.upload || {}), status: 'failed', error: `${e.name || 'Error'}: ${e.message}` }
    const rec = loadRecords(cfg)
    rec.backups = rec.backups.filter((b) => b.name !== name)
    rec.backups.push(meta)
    saveRecords(cfg, rec)
    alert(cfg, `**备份失败** ${name}：${e.message}`)
    throw e
  }
  const rec = loadRecords(cfg)
  rec.backups = rec.backups.filter((b) => b.name !== name)
  rec.backups.push(meta)
  saveRecords(cfg, rec)
  return meta
}
