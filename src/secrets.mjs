import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'
import { ensureDir } from './util.mjs'

const DPAPI_SCRIPT_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security | Out-Null
$s = [Console]::In.ReadToEnd()
$b = [Text.Encoding]::UTF8.GetBytes($s)
$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($e)
`.trim()

const DPAPI_SCRIPT_UNPROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security | Out-Null
$s = [Console]::In.ReadToEnd()
$b = [Convert]::FromBase64String($s.Trim())
$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($p)
`.trim()

function runPowerShell(script, input, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error('DPAPI 调用超时'))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`DPAPI 失败（exit ${code}）：${err.trim().slice(0, 300)}`))
    })
    child.stdin.write(String(input))
    child.stdin.end()
  })
}

export function dpapiSupported() {
  return process.platform === 'win32'
}

export async function dpapiProtect(text) {
  if (!dpapiSupported()) throw new Error('当前平台没有 DPAPI')
  return runPowerShell(DPAPI_SCRIPT_PROTECT, text)
}

export async function dpapiUnprotect(b64) {
  if (!dpapiSupported()) throw new Error('当前平台没有 DPAPI')
  return runPowerShell(DPAPI_SCRIPT_UNPROTECT, b64)
}

export function secretsDir() {
  return join(configDir(), '.private')
}

export function secretsPaths(cfg) {
  const dir = secretsDir()
  return {
    dir,
    dpapi: join(dir, 'secrets.dpapi'),
    plain: join(dir, 'secrets.json'),
  }
}

function legacySecretsPaths(cfg) {
  if (!cfg?.archive?.dir) return null
  const dir = join(cfg.archive.dir, '.private')
  if (dir === secretsDir()) return null
  return {
    dir,
    dpapi: join(dir, 'secrets.dpapi'),
    plain: join(dir, 'secrets.json'),
  }
}

function migrateLegacySecrets(cfg) {
  const old = legacySecretsPaths(cfg)
  if (!old) return
  const neu = secretsPaths(cfg)
  for (const key of ['dpapi', 'plain']) {
    if (!existsSync(neu[key]) && existsSync(old[key])) {
      ensureDir(neu.dir)
      const buf = readFileSync(old[key])
      writeFileSync(neu[key], buf, { mode: 0o600 })
      try { chmodSync(neu[key], 0o600) } catch {}
      try { unlinkSync(old[key]) } catch {}
    }
  }
}

function removeLegacySecrets(cfg) {
  const old = legacySecretsPaths(cfg)
  if (!old) return
  for (const key of ['dpapi', 'plain']) {
    try { if (existsSync(old[key])) unlinkSync(old[key]) } catch {}
  }
}

export async function saveSecrets(cfg, secrets) {
  const p = secretsPaths(cfg)
  ensureDir(p.dir)
  const text = JSON.stringify(secrets)
  let encrypted = false
  let warning = ''
  if (dpapiSupported()) {
    try {
      const b64 = await dpapiProtect(text)
      writeFileSync(p.dpapi, b64 + '\n', 'utf8')
      try { chmodSync(p.dpapi, 0o600) } catch {}
      if (existsSync(p.plain)) unlinkSync(p.plain)
      encrypted = true
    } catch (e) {
      warning = `DPAPI 不可用，已退化为权限受限的明文文件：${e.message}`
    }
  } else {
    warning = '当前平台没有 DPAPI；密钥保存在权限受限的明文文件里（Unix chmod 600）。'
  }
  if (!encrypted) {
    const payload = { _warning: warning, ...secrets }
    writeFileSync(p.plain, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(p.plain, 0o600) } catch {}
    if (existsSync(p.dpapi)) unlinkSync(p.dpapi)
  }
  removeLegacySecrets(cfg)
  return { encrypted, warning, path: encrypted ? p.dpapi : p.plain }
}

export async function loadSecrets(cfg) {
  migrateLegacySecrets(cfg)
  const p = secretsPaths(cfg)
  if (existsSync(p.dpapi)) {
    const b64 = readFileSync(p.dpapi, 'utf8').trim()
    const text = await dpapiUnprotect(b64)
    return { secrets: JSON.parse(text), encrypted: true, path: p.dpapi }
  }
  if (existsSync(p.plain)) {
    const obj = JSON.parse(readFileSync(p.plain, 'utf8'))
    delete obj._warning
    return { secrets: obj, encrypted: false, path: p.plain }
  }
  return { secrets: null, encrypted: false, path: null }
}

export async function secretsStatus(cfg) {
  migrateLegacySecrets(cfg)
  const p = secretsPaths(cfg)
  const hasDpapi = existsSync(p.dpapi)
  const hasPlain = existsSync(p.plain)
  let ok = false
  let encrypted = false
  try {
    if (hasDpapi || hasPlain) {
      const r = await loadSecrets(cfg)
      ok = !!r.secrets
      encrypted = r.encrypted
    }
  } catch {
    ok = false
  }
  return {
    configured: hasDpapi || hasPlain,
    readable: ok,
    encrypted,
    path: hasDpapi ? p.dpapi : hasPlain ? p.plain : '',
  }
}

export async function clearSecrets(cfg) {
  const p = secretsPaths(cfg)
  for (const f of [p.dpapi, p.plain]) {
    try { if (existsSync(f)) unlinkSync(f) } catch {}
  }
  removeLegacySecrets(cfg)
}

export function deriveImapHost(smtpHost) {
  const h = String(smtpHost || '').trim().toLowerCase()
  if (!h) return ''
  if (h === 'smtp.qq.com') return 'imap.qq.com'
  if (h === 'smtp.163.com') return 'imap.163.com'
  if (h === 'smtp.gmail.com') return 'imap.gmail.com'
  if (h === 'smtp.office365.com' || h === 'smtp-mail.outlook.com') return 'outlook.office365.com'
  if (h === 'smtp.126.com') return 'imap.126.com'
  if (h === 'smtp.sina.com') return 'imap.sina.com'
  if (h.startsWith('smtp.')) return 'imap.' + h.slice(5)
  return h
}

export function validatePort(port) {
  const n = Number(port)
  return Number.isInteger(n) && n > 0 && n < 65536
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}
