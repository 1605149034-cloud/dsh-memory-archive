import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { loadConfig, saveConfig, configPath } from '../src/config.mjs'
import { scanAndArchive } from '../src/archive.mjs'
import { rebuildIndex } from '../src/indexer.mjs'
import { createEncryptedZip, verifyEncryptedZip, extractEncryptedZip } from '../src/archive-crypto.mjs'
import { splitFile } from '../src/backup.mjs'
import { retry, sha256Buffer } from '../src/util.mjs'
import { createSmtpUploader } from '../src/uploaders/smtp.mjs'
import { saveSecrets, loadSecrets } from '../src/secrets.mjs'

function tempHome(prefix = 'dma-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, '.dsh')
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  delete process.env.DSH_MEMORY_ARCHIVE_HOME
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function writeSyntheticSession(home, root) {
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const wsPath = join(root, 'workspace')
  mkdirSync(wsPath, { recursive: true })
  const now = Date.now()
  const events = [
    { type: 'session', version: 4, id: sessionId, createdAt: now - 5000, cwd: wsPath, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'session/title', seq: 1, time: now - 4000, data: { title: '测试会话', source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: now - 3000, data: { content: [{ type: 'text', text: '请记住这条测试消息：增量归档必须跳过未变化会话。' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: now - 2000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到，这是测试回复。' }] } } },
    { type: 'tool/result', seq: 4, time: now - 1000, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'tool output' }] }, toolCallId: 'call-1' } },
  ]
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const wsDir = join(home, 'sessions', '--test-workspace--')
  const sdir = join(wsDir, sessionId)
  mkdirSync(sdir, { recursive: true })
  writeFileSync(join(sdir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
  const reg = {
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: wsPath, title: 'TestWS', sessionIds: [sessionId], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } } },
  }
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(reg, null, 2))
  return { sessionId, wsPath }
}

test('配置读写：改 archive.mode 后重新加载仍生效', () => {
  const t = tempHome()
  try {
    const cfg = loadConfig()
    assert.equal(existsSync(configPath()), true)
    cfg.archive.mode = 'full'
    saveConfig(cfg)
    const again = loadConfig()
    assert.equal(again.archive.mode, 'full')
    assert.equal(again.archive.dir, cfg.archive.dir)
  } finally { t.cleanup() }
})

test('增量判定：第二次扫描跳过未变化会话', async () => {
  const t = tempHome()
  try {
    writeSyntheticSession(t.home, t.root)
    const cfg = loadConfig()
    cfg.archive.sessionsDir = join(t.home, 'sessions')
    cfg.archive.dir = join(t.root, 'archive')
    cfg.backup.dir = join(t.root, 'backups')
    saveConfig(cfg)
    const first = await scanAndArchive(cfg, { mode: 'incremental' })
    assert.equal(first.stats.processed, 1)
    const idx = rebuildIndex(cfg)
    assert.ok(idx.entries >= 1)
    const second = await scanAndArchive(cfg, { mode: 'incremental' })
    assert.equal(second.stats.processed, 0)
    assert.ok(second.stats.skipped_unchanged >= 1)
    assert.equal(second.stats.written_files, 0)
  } finally { t.cleanup() }
})

test('加密解密往返：AES-256 zip 可解且错误密码失败', async () => {
  const t = tempHome('dma-zip-')
  try {
    const f = join(t.root, 'a.txt')
    writeFileSync(f, 'hello 记忆库\n'.repeat(50), 'utf8')
    const zip = join(t.root, 'a.zip')
    const pw = 'password-1234567890'
    await createEncryptedZip([{ path: f, arcname: 'sub/a.txt' }], zip, pw)
    const names = await verifyEncryptedZip(zip, pw)
    assert.deepEqual(names.map((x) => x.filename), ['sub/a.txt'])
    const out = join(t.root, 'out')
    await extractEncryptedZip(zip, pw, out)
    assert.equal(readFileSync(join(out, 'sub', 'a.txt'), 'utf8'), readFileSync(f, 'utf8'))
    await assert.rejects(() => verifyEncryptedZip(zip, 'wrong-password-000'))
  } finally { t.cleanup() }
})

test('分卷命名：2.5MB 按 1MB 切成 partNNofNN.zip.NNN', () => {
  const t = tempHome('dma-split-')
  try {
    const f = join(t.root, '2026-11-03.zip')
    writeFileSync(f, Buffer.alloc(2.5 * 1024 * 1024, 7))
    const parts = splitFile(f, 1024 * 1024)
    assert.equal(parts.length, 3)
    assert.equal(parts[0].split(/[\\/]/).pop(), '2026-11-03-part01of03.zip.001')
    assert.equal(parts[2].split(/[\\/]/).pop(), '2026-11-03-part03of03.zip.003')
    const joined = Buffer.concat(parts.map((p) => readFileSync(p)))
    assert.equal(sha256Buffer(joined), sha256Buffer(readFileSync(f)))
  } finally { t.cleanup() }
})

test('SMTP 失败路径：错误主机必须 reject，不静默成功', async () => {
  const t = tempHome('dma-smtp-')
  try {
    const cfg = loadConfig()
    cfg.uploader.type = 'smtp'
    cfg.uploader.smtp = { host: '127.0.0.1', port: 1, secure: true, user: 'test@example.com', to: 'test@example.com', imapHost: '127.0.0.1', imapPort: 1 }
    const uploader = createSmtpUploader(cfg, { smtpPassword: 'x' })
    await assert.rejects(() => uploader.checkAuth())
  } finally { t.cleanup() }
})

test('退避重试：前两次失败第三次成功', async () => {
  let n = 0
  const value = await retry(async () => {
    n++
    if (n < 3) throw new Error(`fail ${n}`)
    return 'ok'
  }, { attempts: 4, baseMs: 1, factor: 1 })
  assert.equal(value, 'ok')
  assert.equal(n, 3)
})

test('密钥目录跟随 DSH_MEMORY_ARCHIVE_HOME，改归档目录不影响', async () => {
  const t = tempHome('dma-secrets-')
  try {
    const cfg = loadConfig()
    cfg.archive.dir = join(t.root, 'archive-a')
    cfg.backup.dir = join(t.root, 'backup-a')
    saveConfig(cfg)
    const saved = await saveSecrets(cfg, { backupPassword: 'password-1234567890', smtpPassword: 'x' })
    assert.ok(saved.path.includes(`memory-archive${requireSep()}.private`))
    cfg.archive.dir = join(t.root, 'archive-b')
    cfg.backup.dir = join(t.root, 'backup-b')
    saveConfig(cfg)
    const loaded = await loadSecrets(cfg)
    assert.equal(loaded.secrets.backupPassword, 'password-1234567890')
    assert.equal(loaded.path, saved.path)
  } finally { t.cleanup() }
})

function requireSep() {
  return process.platform === 'win32' ? '\\' : '/'
}
