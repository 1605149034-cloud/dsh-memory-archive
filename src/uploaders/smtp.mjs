import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function transportFor(cfg, secrets) {
  const s = cfg.uploader.smtp
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 465,
    secure: s.secure !== false,
    requireTLS: s.secure === false,
    auth: { user: s.user, pass: secrets.smtpPassword },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 120000,
  })
}

function imapClient(cfg, secrets) {
  const s = cfg.uploader.smtp
  return new ImapFlow({
    host: s.imapHost,
    port: Number(s.imapPort) || 993,
    secure: true,
    auth: { user: s.user, pass: secrets.smtpPassword },
    logger: false,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 120000,
  })
}

function decodeName(v) {
  return String(v || '').replace(/\s+/g, ' ').trim()
}

export function createSmtpUploader(cfg, secrets) {
  const s = cfg.uploader.smtp
  return {
    type: 'smtp',
    async checkAuth() {
      const t = transportFor(cfg, secrets)
      try {
        await t.verify()
        return { ok: true }
      } finally {
        t.close()
      }
    },
    async send({
      filePath, partName, partIndex, totalParts, date, kind, token,
      sha256, wholeSize,
    }) {
      if (!existsSync(filePath)) throw new Error(`附件不存在：${filePath}`)
      const t = transportFor(cfg, secrets)
      const to = s.to || s.user
      const subject = `[dsh-memory-archive] ${date} ${kind === 'weekly' ? '全量' : '增量'}备份 ` +
        `(${partIndex}/${totalParts}) ${token}`
      const text = [
        'dsh-memory-archive 加密备份',
        `date: ${date}`,
        `kind: ${kind}`,
        `part: ${partName} (${partIndex}/${totalParts})`,
        `whole_sha256: ${sha256}`,
        `whole_size: ${wholeSize}`,
        '',
        '密码不在邮件里；它只保存在本机加密密钥库（Windows DPAPI 优先）。',
        '分卷合并：按文件名顺序把 .001/.002/... 做二进制拼接，再用备份密码解压。',
      ].join('\n')
      try {
        const info = await t.sendMail({
          from: s.user,
          to,
          subject,
          text,
          attachments: [{ filename: partName, path: filePath }],
        })
        return { messageId: info.messageId || '', subject }
      } finally {
        t.close()
      }
    },
    async verify({ token, expectedSha256, expectedNames, attempts = 10, baseMs = 2000 }) {
      let lastError = ''
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const client = imapClient(cfg, secrets)
        try {
          await client.connect()
          const mailbox = await client.mailboxOpen('INBOX')
          let uids = []
          try {
            uids = await client.search({ subject: token }, { uid: true })
          } catch {
            uids = []
          }
          if (!uids?.length) {
            const status = await client.status('INBOX', { messages: true })
            const total = status.messages || 0
            if (total > 0) {
              const from = Math.max(1, total - 79)
              for await (const msg of client.fetch(`${from}:*`, { envelope: true, uid: true }, { uid: true })) {
                const subj = decodeName(msg.envelope?.subject)
                if (subj.includes(token)) uids.push(msg.uid)
              }
            }
          }
          const found = new Map()
          for (const uid of uids) {
            const msg = await client.fetchOne(uid, { source: true }, { uid: true })
            if (!msg?.source) continue
            const parsed = await simpleParser(msg.source)
            for (const att of parsed.attachments || []) {
              const name = decodeName(att.filename)
              if (expectedNames.includes(name)) found.set(name, att.content)
            }
          }
          if (found.size === expectedNames.length) {
            const blob = Buffer.concat(expectedNames.map((n) => found.get(n)))
            const got = sha256Buffer(blob)
            if (got === expectedSha256) {
              return { status: 'verified', downloadSha256: got, parts: expectedNames, attempt, mailbox: mailbox?.path || 'INBOX' }
            }
            lastError = `下载后 sha256 不一致：${got.slice(0, 16)}… != ${expectedSha256.slice(0, 16)}…`
          } else {
            lastError = `未找齐附件（${found.size}/${expectedNames.length}）`
          }
        } catch (e) {
          lastError = `${e.name || 'Error'}: ${e.message}`
        } finally {
          try { await client.logout() } catch {}
        }
        if (attempt < attempts) await new Promise((r) => setTimeout(r, baseMs * attempt))
      }
      return { status: 'failed', error: lastError, parts: expectedNames }
    },
  }
}
