import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function createLocalUploader(cfg) {
  return {
    type: 'local_only',
    async checkAuth() { return { ok: true } },
    async send({ filePath, partName, partIndex, totalParts, backupDir }) {
      const dir = backupDir || cfg.backup.dir
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, partName)
      if (String(filePath) !== dest) copyFileSync(filePath, dest)
      return { messageId: '', subject: 'local', status: 'local', path: dest, partIndex, totalParts }
    },
    async verify({ expectedSha256, expectedNames, backupDir }) {
      const dir = backupDir || cfg.backup.dir
      const files = expectedNames.map((n) => join(dir, n))
      if (!files.every((f) => existsSync(f))) return { status: 'failed', error: '本地备份文件不存在' }
      const blob = Buffer.concat(files.map((f) => readFileSync(f)))
      const got = sha256Buffer(blob)
      if (got !== expectedSha256) return { status: 'failed', error: `sha256 不一致：${got}` }
      return { status: 'verified', downloadSha256: got, parts: expectedNames, mailbox: 'local' }
    },
  }
}

export function createWebhookUploader(cfg, secrets) {
  const w = cfg.uploader.webhook
  return {
    type: 'webhook',
    async checkAuth() {
      if (!w.url) throw new Error('webhook URL 未配置')
      return { ok: true, note: 'webhook 的可用性在 send 时检查' }
    },
    async send({ filePath, partName, partIndex, totalParts, date, kind, token, sha256 }) {
      if (!w.url) throw new Error('webhook URL 未配置')
      if (!existsSync(filePath)) throw new Error(`附件不存在：${filePath}`)
      const fd = new FormData()
      fd.append('date', date)
      fd.append('kind', kind)
      fd.append('token', token)
      fd.append('part', String(partIndex))
      fd.append('totalParts', String(totalParts))
      fd.append('sha256', sha256)
      const buf = (await import('node:fs')).readFileSync(filePath)
      fd.append('file', new Blob([buf], { type: 'application/zip' }), partName)
      const headers = { ...(w.headers || {}) }
      if (secrets.webhookToken) headers.Authorization = `Bearer ${secrets.webhookToken}`
      const res = await fetch(w.url, { method: 'POST', headers, body: fd })
      const text = await res.text()
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}：${text.slice(0, 300)}`)
      let remoteSha = ''
      try {
        const j = JSON.parse(text)
        remoteSha = String(j.sha256 || j.sha || '')
      } catch {}
      return {
        messageId: '', subject: 'webhook', status: remoteSha ? 'sent' : 'sent',
        remoteSha256: remoteSha, response: text.slice(0, 300),
      }
    },
    async verify({ sendResult, expectedSha256 }) {
      if (sendResult?.remoteSha256 && sendResult.remoteSha256 !== expectedSha256) {
        return { status: 'failed', error: `webhook 返回 sha256 不一致：${sendResult.remoteSha256}` }
      }
      if (sendResult?.remoteSha256 === expectedSha256) {
        return { status: 'verified', downloadSha256: expectedSha256, parts: [] }
      }
      return { status: 'sent', error: '', parts: [] }
    },
  }
}

export function createUploader(cfg, secrets) {
  const type = String(cfg.uploader.type || 'local_only')
  if (type === 'smtp') {
    // 延迟 import，避免 local_only 用户无谓加载 mail 依赖
    return import('./smtp.mjs').then((m) => m.createSmtpUploader(cfg, secrets))
  }
  if (type === 'webhook') return Promise.resolve(createWebhookUploader(cfg, secrets))
  return Promise.resolve(createLocalUploader(cfg))
}
