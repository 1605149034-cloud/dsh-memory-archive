import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncryptedZip, verifyEncryptedZip } from './archive-crypto.mjs'
import { createUploader } from './uploaders/index.mjs'
import { sha256File, fileSize } from './util.mjs'

export async function healthCheck(cfg, secrets) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-memory-archive-health-'))
  const details = { uploader: cfg.uploader.type, steps: [] }
  try {
    const password = secrets?.backupPassword
    if (!password) throw new Error('备份密码未配置')
    const textFile = join(tmp, 'health.txt')
    writeFileSync(textFile, `dsh-memory-archive health check ${new Date().toISOString()}\n`, 'utf8')
    const zip = join(tmp, 'health.zip')
    await createEncryptedZip([{ path: textFile, arcname: 'health.txt' }], zip, password)
    await verifyEncryptedZip(zip, password)
    details.steps.push({ step: 'encrypt', ok: true, sha256: sha256File(zip) })
    const sha = sha256File(zip)
    const token = `dma-health-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const uploader = await createUploader(cfg, secrets)
    if (uploader.type === 'smtp') {
      await uploader.checkAuth()
      details.steps.push({ step: 'smtp-login', ok: true })
      const name = `health-${token}.zip`
      const sent = await uploader.send({
        filePath: zip, partName: name, partIndex: 1, totalParts: 1,
        date: 'health', kind: 'daily', token, sha256: sha, wholeSize: fileSize(zip),
      })
      details.steps.push({ step: 'smtp-send', ok: true, messageId: sent.messageId || '' })
      const vr = await uploader.verify({ token, expectedSha256: sha, expectedNames: [name], attempts: 10, baseMs: 2000 })
      if (vr.status !== 'verified') throw new Error(`IMAP 回取校验失败：${vr.error || vr.status}`)
      details.steps.push({ step: 'imap-download-sha256', ok: true, sha256: vr.downloadSha256 })
      return { ok: true, ...details }
    }
    if (uploader.type === 'webhook') {
      const name = `health-${token}.zip`
      const sent = await uploader.send({
        filePath: zip, partName: name, partIndex: 1, totalParts: 1,
        date: 'health', kind: 'daily', token, sha256: sha, wholeSize: 0,
      })
      const vr = await uploader.verify({ sendResult: sent, expectedSha256: sha })
      if (vr.status === 'failed') throw new Error(vr.error || 'webhook 校验失败')
      details.steps.push({ step: 'webhook-send', ok: true, status: vr.status })
      return { ok: true, ...details, note: vr.status === 'sent' ? 'webhook 已发送但未返回 sha256，无法做下载回验收' : '' }
    }
    const sent = await uploader.send({
      filePath: zip, partName: `health-${token}.zip`, partIndex: 1, totalParts: 1,
      date: 'health', kind: 'daily', token, sha256: sha, wholeSize: 0, backupDir: tmp,
    })
    const vr = await uploader.verify({ expectedSha256: sha, expectedNames: [`health-${token}.zip`], backupDir: tmp })
    if (vr.status !== 'verified') throw new Error(vr.error || 'local 校验失败')
    details.steps.push({ step: 'local-sha256', ok: true, status: vr.status })
    return { ok: true, ...details }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}
