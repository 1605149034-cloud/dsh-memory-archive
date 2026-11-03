import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ensureDir, expandHome, readJson, writeJson } from './util.mjs'

export function dshHome() {
  return expandHome(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

export function configDir() {
  return expandHome(process.env.DSH_MEMORY_ARCHIVE_HOME || join(dshHome(), 'memory-archive'))
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function defaultTagRules() {
  return [
    { tag: '代码', pattern: '功能|代码|报错|bug|修复|重构|测试' },
    { tag: '视频', pattern: '视频|投稿|字幕|封面|剪辑|发布' },
    { tag: '运维', pattern: '备份|恢复|部署|重启|计划任务|体检|排障' },
    { tag: 'AI', pattern: '模型|训练|推理|提示词|token|embedding|RAG' },
  ]
}

export function defaultConfig() {
  const home = dshHome()
  const archive = join(configDir())
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    timezone: 'local',
    archive: {
      dir: archive,
      sessionsDir: join(home, 'sessions'),
      workspaceJson: join(home, 'storages', 'workspace.json'),
      scope: 'all',
      workspaces: [],
      mode: 'incremental',
      maxToolChars: 4096,
      summary: false,
    },
    schedule: {
      enabled: true,
      dailyAt: '09:50',
      weeklyAt: '10:10',
      weeklyDay: 0,
    },
    backup: {
      dir: join(archive, 'backups'),
      maxAttachmentMB: 50,
      keepDays: 0,
    },
    uploader: {
      type: 'local_only',
      smtp: {
        host: '',
        port: 465,
        secure: true,
        user: '',
        to: '',
        imapHost: '',
        imapPort: 993,
      },
      webhook: {
        url: '',
        headers: {},
      },
    },
    installed: false,
    installNote: '',
  }
}

export function loadConfig({ create = true } = {}) {
  const file = configPath()
  let cfg = readJson(file, null)
  if (!cfg || typeof cfg !== 'object') {
    cfg = defaultConfig()
    if (create) saveConfig(cfg)
    return cfg
  }
  // 补齐旧版本缺的字段，不覆盖用户设置
  const base = defaultConfig()
  cfg.version = cfg.version || 1
  cfg.archive = { ...base.archive, ...(cfg.archive || {}) }
  cfg.schedule = { ...base.schedule, ...(cfg.schedule || {}) }
  cfg.backup = { ...base.backup, ...(cfg.backup || {}) }
  cfg.uploader = {
    ...base.uploader,
    ...(cfg.uploader || {}),
    smtp: { ...base.uploader.smtp, ...((cfg.uploader || {}).smtp || {}) },
    webhook: { ...base.uploader.webhook, ...((cfg.uploader || {}).webhook || {}) },
  }
  cfg.archive.dir = expandHome(cfg.archive.dir || base.archive.dir)
  cfg.archive.sessionsDir = expandHome(cfg.archive.sessionsDir || base.archive.sessionsDir)
  cfg.backup.dir = expandHome(cfg.backup.dir || base.backup.dir)
  cfg.timezone = cfg.timezone || 'local'
  return cfg
}

export function saveConfig(cfg) {
  cfg.archive.dir = expandHome(cfg.archive.dir)
  cfg.archive.sessionsDir = expandHome(cfg.archive.sessionsDir)
  cfg.backup.dir = expandHome(cfg.backup.dir)
  ensureDir(configDir())
  ensureDir(cfg.archive.dir)
  ensureDir(cfg.backup.dir)
  writeJson(configPath(), cfg)
}

export function workspaceRegistryPath(cfg) {
  const candidates = [
    cfg?.archive?.workspaceJson,
    join(dshHome(), 'storages', 'workspace.json'),
    join(dshHome(), 'workspace.json'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(expandHome(p))) || candidates[1]
}

export function workspaceMap(cfg) {
  const pathMap = new Map()
  const sessionMap = new Map()
  const regPath = workspaceRegistryPath(cfg)
  const raw = readJson(regPath, null)
  const workspaces = raw?.tables?.workspaces || {}
  for (const [id, w] of Object.entries(workspaces)) {
    const title = String(w?.title || '')
    const p = String(w?.path || '')
    if (p) pathMap.set(p.replace(/[\\/]+$/, '').toLowerCase(), title)
    for (const sid of w?.sessionIds || []) sessionMap.set(String(sid), title)
  }
  return { pathMap, sessionMap, registryPath: regPath, raw }
}

export function listWorkspaces(cfg) {
  const { pathMap } = workspaceMap(cfg)
  return [...pathMap.entries()].map(([path, title]) => ({ path, title }))
}

export function resolveWorkspace(cfg, cwd, sessionId) {
  const { pathMap, sessionMap } = workspaceMap(cfg)
  const key = String(cwd || '').replace(/[\\/]+$/, '').toLowerCase()
  if (pathMap.has(key) && pathMap.get(key)) return pathMap.get(key)
  if (sessionMap.has(String(sessionId)) && sessionMap.get(String(sessionId))) return sessionMap.get(String(sessionId))
  if (cwd) {
    const tail = String(cwd).replace(/\//g, '\\').replace(/\\+$/, '').split('\\').pop()
    if (tail) return tail
  }
  return '未登记工作区'
}

export function workspaceAllowed(cfg, workspace) {
  if (cfg.archive.scope !== 'custom') return true
  const list = (cfg.archive.workspaces || []).map((x) => String(x).toLowerCase())
  return list.length === 0 || list.includes(String(workspace).toLowerCase())
}

export function archiveDir(cfg) {
  return expandHome(cfg.archive.dir)
}

export function backupDir(cfg) {
  return expandHome(cfg.backup.dir)
}

export function statePath(cfg) {
  return join(archiveDir(cfg), 'state.json')
}

export function indexFilePath(cfg) {
  return join(archiveDir(cfg), 'index.md')
}

export function tagsFilePath(cfg) {
  return join(archiveDir(cfg), 'tags.json')
}

export function tagRulesPath(cfg) {
  return join(archiveDir(cfg), 'tag_rules.json')
}

export function logsDir(cfg) {
  return join(archiveDir(cfg), 'logs')
}

export function ensureLayout(cfg) {
  ensureDir(archiveDir(cfg))
  ensureDir(backupDir(cfg))
  ensureDir(logsDir(cfg))
}

export function loadTagRules(cfg) {
  const file = tagRulesPath(cfg)
  const rules = readJson(file, null)
  if (Array.isArray(rules)) return rules
  const defaults = defaultTagRules()
  writeJson(file, defaults)
  return defaults
}
