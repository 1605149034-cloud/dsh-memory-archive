import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { existsSync } from 'node:fs'
import {
  configPath, defaultConfig, dshHome, listWorkspaces, loadConfig, saveConfig,
} from './config.mjs'
import { deriveImapHost, saveSecrets, validateEmail, validatePort } from './secrets.mjs'
import { healthCheck } from './health.mjs'
import { ensureDir } from './util.mjs'

function env(name) {
  return String(process.env[name] || '').trim()
}

class Prompter {
  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout })
  }
  async ask(question, defaultValue = '') {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const ans = (await this.rl.question(`${question}${suffix}: `)).trim()
    return ans || String(defaultValue || '')
  }
  async hidden(question) {
    if (!stdin.isTTY) {
      const ans = (await this.rl.question(`${question}: `)).trim()
      return ans
    }
    this.rl.pause()
    stdout.write(`${question}: `)
    return new Promise((resolve, reject) => {
      let val = ''
      const onData = (buf) => {
        const s = buf.toString('utf8')
        for (const c of s) {
          if (c === '\r' || c === '\n') {
            cleanup()
            stdout.write('\n')
            resolve(val)
            return
          }
          if (c === '\u0003') {
            cleanup()
            stdout.write('\n')
            reject(new Error('用户取消'))
            return
          }
          if (c === '\u007f' || c === '\b') {
            val = val.slice(0, -1)
          } else if (c >= ' ') {
            val += c
          }
        }
      }
      const cleanup = () => {
        stdin.off('data', onData)
        try { stdin.setRawMode(false) } catch {}
        stdin.pause()
        this.rl.resume()
      }
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData)
    })
  }
  close() {
    this.rl.close()
  }
}

function readSecretEnv(name, label) {
  const v = env(name)
  if (!v) throw new Error(`非交互模式需要环境变量 ${name}（${label}）`)
  return v
}

async function choose(p, question, options, defaultIndex = 0) {
  console.log(`\n${question}`)
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.note ? ` — ${o.note}` : ''}`))
  const raw = await p.ask('选择', String(defaultIndex + 1))
  const n = Math.max(1, Math.min(options.length, Number(raw) || (defaultIndex + 1)))
  return options[n - 1].value
}

export async function runInit(opts = {}) {
  const nonInteractive = !!opts.nonInteractive || !stdin.isTTY
  const cfg = loadConfig({ create: true })
  const base = defaultConfig()
  if (opts.archiveDir) cfg.archive.dir = opts.archiveDir
  if (opts.backupDir) cfg.backup.dir = opts.backupDir
  if (opts.sessionsDir) cfg.archive.sessionsDir = opts.sessionsDir
  const p = nonInteractive ? null : new Prompter()
  let scope = opts.scope
  let workspaces = opts.workspaces ? String(opts.workspaces).split(',').map((s) => s.trim()).filter(Boolean) : []
  let mode = opts.mode
  let uploader = opts.uploader
  let smtp = {
    host: opts.smtpHost || '',
    port: Number(opts.smtpPort || 465),
    secure: Number(opts.smtpPort || 465) !== 587,
    user: opts.smtpUser || '',
    to: opts.smtpTo || '',
    imapHost: opts.imapHost || '',
    imapPort: Number(opts.imapPort || 993),
  }
  let webhookUrl = opts.webhookUrl || ''
  let webhookToken = env('DMA_WEBHOOK_TOKEN')
  let smtpPassword = env('DMA_SMTP_PASSWORD')
  let backupPassword = env('DMA_BACKUP_PASSWORD')
  let archiveDir = opts.archiveDir || cfg.archive.dir

  try {
    if (!scope) {
      if (nonInteractive) scope = 'all'
      else {
        scope = await choose(p, '归档范围？', [
          { value: 'all', label: '全部工作区', note: '默认' },
          { value: 'custom', label: '指定工作区', note: '从 DSH 登记表里选' },
        ])
        if (scope === 'custom') {
          const all = listWorkspaces(cfg)
          if (!all.length) {
            console.log('（登记表里没读到工作区，先按全部处理）')
            scope = 'all'
          } else {
            console.log('\n可选工作区：')
            all.forEach((w, i) => console.log(`  ${i + 1}. ${w.title} — ${w.path}`))
            const ans = await p.ask('输入编号，逗号分隔')
            workspaces = ans.split(/[,，]/).map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= all.length).map((n) => all[n - 1].title)
            if (!workspaces.length) scope = 'all'
          }
        }
      }
    }

    if (!mode) {
      if (nonInteractive) mode = 'incremental'
      else {
        mode = await choose(p, '归档模式？', [
          { value: 'incremental', label: 'incremental', note: '只归档有变动的会话，推荐' },
          { value: 'full', label: 'full', note: '每次全量重扫' },
        ])
      }
    }

    if (!uploader) {
      if (nonInteractive) uploader = 'local_only'
      else {
        uploader = await choose(p, '备份上传通道？', [
          { value: 'smtp', label: 'smtp', note: '发到自己邮箱，推荐；会做回取 sha256 校验' },
          { value: 'webhook', label: 'webhook', note: 'POST 到自定义地址' },
          { value: 'local_only', label: 'local_only', note: '只落本地加密包，不联网' },
        ])
      }
    }

    if (uploader === 'smtp') {
      if (!nonInteractive) {
        console.log('\nSMTP 配置（QQ/163/Gmail/Outlook 均可；授权码不是登录密码）')
      }
      smtp.host = smtp.host || (nonInteractive ? env('DMA_SMTP_HOST') : await p.ask('SMTP 主机', 'smtp.qq.com'))
      if (!smtp.host) throw new Error('缺少 SMTP 主机')
      const portRaw = nonInteractive ? String(smtp.port) : await p.ask('SMTP 端口（465=SSL，587=STARTTLS）', String(smtp.port))
      smtp.port = Number(portRaw)
      if (!validatePort(smtp.port)) throw new Error('SMTP 端口无效')
      smtp.secure = smtp.port !== 587
      smtp.user = smtp.user || (nonInteractive ? env('DMA_SMTP_USER') : await p.ask('邮箱账号（完整地址）'))
      if (!validateEmail(smtp.user)) throw new Error('邮箱账号格式不正确')
      smtp.to = smtp.to || (nonInteractive ? (env('DMA_SMTP_TO') || smtp.user) : await p.ask('收件人（默认发给自己）', smtp.user))
      if (!validateEmail(smtp.to)) throw new Error('收件人格式不正确')
      smtp.imapHost = smtp.imapHost || (nonInteractive ? (env('DMA_IMAP_HOST') || deriveImapHost(smtp.host)) : await p.ask('IMAP 主机（用于回取验证）', deriveImapHost(smtp.host)))
      smtp.imapPort = Number(nonInteractive ? (env('DMA_IMAP_PORT') || smtp.imapPort) : await p.ask('IMAP 端口', String(smtp.imapPort)))
      if (!validatePort(smtp.imapPort)) throw new Error('IMAP 端口无效')
      if (!smtpPassword) {
        if (nonInteractive) throw new Error('非交互模式需要环境变量 DMA_SMTP_PASSWORD')
        smtpPassword = await p.hidden('SMTP 授权码 / 应用密码（输入不回显）')
      }
      if (!smtpPassword) throw new Error('SMTP 授权码不能为空')
    } else if (uploader === 'webhook') {
      webhookUrl = webhookUrl || (nonInteractive ? env('DMA_WEBHOOK_URL') : await p.ask('Webhook URL'))
      if (!webhookUrl) throw new Error('缺少 Webhook URL')
      if (!webhookToken && !nonInteractive) {
        const t = await p.hidden('Webhook Token（可留空，输入不回显）')
        webhookToken = t || ''
      }
    }

    if (!backupPassword) {
      if (nonInteractive) throw new Error('非交互模式需要环境变量 DMA_BACKUP_PASSWORD')
      console.log('\n备份加密密码：至少 16 位。丢了它，加密备份永远打不开；请自己离线抄一份。')
      while (!backupPassword || backupPassword.length < 16) {
        backupPassword = await p.hidden('设置备份密码（输入不回显，≥16 位）')
        if (backupPassword.length < 16) console.log('太短，至少 16 位。')
      }
      const again = await p.hidden('再输一次确认')
      if (again !== backupPassword) throw new Error('两次输入的备份密码不一致')
    }
    if (backupPassword.length < 16) throw new Error('备份密码至少 16 位')

    if (!nonInteractive && !opts.archiveDir) {
      const dir = await p.ask('归档目录（默认即可）', archiveDir)
      archiveDir = dir || archiveDir
    }
    cfg.archive.dir = archiveDir
    if (!opts.backupDir) cfg.backup.dir = opts.backupDir || `${archiveDir}/backups`
    cfg.archive.scope = scope || 'all'
    cfg.archive.workspaces = workspaces
    cfg.archive.mode = mode || 'incremental'
    cfg.uploader.type = uploader
    cfg.uploader.smtp = { ...smtp, host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, to: smtp.to, imapHost: smtp.imapHost, imapPort: smtp.imapPort }
    cfg.uploader.webhook = { url: webhookUrl, headers: webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {} }
    cfg.installed = false
    cfg.installNote = ''
    ensureDir(cfg.archive.dir)
    ensureDir(cfg.backup.dir)
    saveConfig(cfg)
    const saved = await saveSecrets(cfg, { smtpPassword, backupPassword, webhookToken })
    if (saved.warning) {
      console.log(`\n[WARN] ${saved.warning}`)
      console.log(`[WARN] 密钥文件：${saved.path}（请确保只有你自己能读）`)
    } else {
      console.log(`\n[OK] 密钥已用系统级加密保存：${saved.path}`)
    }
    console.log(`[OK] 配置已写：${configPath()}`)

    if (opts.noHealth) {
      console.log('[SKIP] 按 --no-health 跳过健康检查；配置已保存，但未标记为已安装。')
      return { ok: false, cfg, health: null }
    }
    console.log('\n[health] 正在做健康检查（加密 → 发送 → 回取 → sha256）…')
    const health = await healthCheck(cfg, { smtpPassword, backupPassword, webhookToken })
    cfg.installed = !!health.ok
    cfg.installNote = health.ok ? 'health check passed' : 'health check failed'
    saveConfig(cfg)
    if (!health.ok) {
      console.error('[FAIL] 健康检查未通过，配置已保存但未标记为安装完成。')
      return { ok: false, cfg, health }
    }
    console.log('[OK] 健康检查全绿。')
    console.log(`\n下一步：\n  1) 归档一次：dsh-memory-archive archive --backfill 30\n  2) 检索：dsh-memory-archive search --tag <标签>\n  3) 备份：dsh-memory-archive backup`)
    return { ok: true, cfg, health }
  } finally {
    if (p) p.close()
  }
}

export function hasConfig() {
  return existsSync(configPath())
}
