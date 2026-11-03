import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveDir, configPath, loadConfig } from './config.mjs'
import { createEncryptedZip, verifyEncryptedZip } from './archive-crypto.mjs'
import { loadRecords } from './backup.mjs'
import { healthCheck } from './health.mjs'
import { collectEntries } from './indexer.mjs'
import { loadSecrets } from './secrets.mjs'
import { readRange, search } from './search.mjs'
import { fileSize, readFrontMatter, sha256File } from './util.mjs'

function check(list, name, ok, detail = '') {
  list.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? `  — ${detail}` : ''}`)
}

export async function runSelftest(cfg = loadConfig({ create: false }), {
  offline = false, checkUpload = false,
} = {}) {
  const checks = []
  check(checks, '1. 配置存在', existsSync(configPath()), configPath())
  let secrets = null
  try {
    const r = await loadSecrets(cfg)
    secrets = r.secrets
    check(checks, '2. 密钥库可读', !!secrets, r.encrypted ? '系统加密' : '仅文件权限')
  } catch (e) {
    check(checks, '2. 密钥库可读', false, e.message)
  }
  check(checks, '3. sessions 目录存在', existsSync(cfg.archive.sessionsDir), cfg.archive.sessionsDir)
  const entries = collectEntries(cfg)
  check(checks, '4. 已有归档切片', entries.length > 0, `${entries.length} 个`)

  let searchOk = false
  let readOk = false
  if (entries.length) {
    const tag = entries[0].tags?.[0]
    const results = search(cfg, { tag, limit: 3 })
    searchOk = results.length > 0
    check(checks, '5. 检索可命中', searchOk, `tag=${tag || '—'}，${results.length} 条`)
    if (results.length) {
      const r = results.find((x) => x.round > 0) || results[0]
      const round = r.round || 1
      try {
        const text = readRange(cfg, r.file, round, round)
        readOk = text.length > 40
        check(checks, '6. 按轮次读原文', readOk, `${text.length} 字符`)
      } catch (e) {
        check(checks, '6. 按轮次读原文', false, e.message)
      }
    } else {
      check(checks, '6. 按轮次读原文', false, '没有可读结果')
    }
  } else {
    check(checks, '5. 检索可命中', false, '没有切片')
    check(checks, '6. 按轮次读原文', false, '没有切片')
  }

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-memory-archive-selftest-'))
  try {
    const f = join(tmp, 'check.txt')
    writeFileSync(f, 'selftest\n', 'utf8')
    const zip = join(tmp, 'check.zip')
    const pw = secrets?.backupPassword || 'selftest-password-1234'
    await createEncryptedZip([{ path: f, arcname: 'check.txt' }], zip, pw)
    await verifyEncryptedZip(zip, pw)
    check(checks, '7. 加密包可解', true, `${fileSize(zip)} bytes`)
  } catch (e) {
    check(checks, '7. 加密包可解', false, e.message)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  let backupOk = false
  try {
    const rec = loadRecords(cfg)
    const latest = rec.backups?.[rec.backups.length - 1]
    if (latest?.path && existsSync(latest.path)) {
      backupOk = sha256File(latest.path) === latest.sha256
      check(checks, '8. 备份 sha256', backupOk, `${latest.name} ${latest.upload?.status || ''}`)
    } else {
      check(checks, '8. 备份 sha256', false, '没有备份记录')
    }
  } catch (e) {
    check(checks, '8. 备份 sha256', false, e.message)
  }

  if (offline) {
    console.log('[SKIP] 9. 上传通道连通性（--offline）')
  } else if (checkUpload) {
    try {
      console.log('[..] 9. 上传通道连通性：正在发送测试邮件/请求…')
      const h = await healthCheck(cfg, secrets)
      check(checks, '9. 上传通道连通性', !!h.ok, h.steps?.map((s) => s.step).join(' → '))
    } catch (e) {
      check(checks, '9. 上传通道连通性', false, `${e.name || 'Error'}: ${e.message}`)
    }
  } else {
    console.log('[SKIP] 9. 上传通道连通性（加 --check-upload 验证）')
  }

  const failed = checks.filter((c) => !c.ok)
  const ok = failed.length === 0
  console.log(`\n结果：${ok ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length}）`)
  if (!checkUpload && !offline) console.log('提示：网络通道尚未验证；用 selftest --check-upload 做真实发送/回取。')
  if (offline) console.log('提示：--offline 跳过了网络检查，不代表上传通道可用。')
  return { ok, checks, offline, checkUpload }
}
