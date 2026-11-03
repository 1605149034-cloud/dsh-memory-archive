/**
 * dsh-memory-archive —— DSH 插件 host 入口。
 * 纯 Node；不依赖 Python、不依赖本机私有路径。
 * 工具：memory_search / memory_read / memory_backup_now / memory_status
 */
import { loadConfig } from './src/config.mjs'
import { search, readRange } from './src/search.mjs'
import { backupNow } from './src/backup.mjs'
import { getStatus } from './src/status.mjs'
import { loadSecrets } from './src/secrets.mjs'
import { startScheduler } from './src/scheduler.mjs'

export const name = 'memory-archive'
export const inject = ['tools']

let defineTool = (options) => options
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod?.defineTool === 'function') defineTool = mod.defineTool
} catch { /* 桌面版可能没有该模块，退回本地等价实现 */ }

function safe(v) {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

function cfgOrError() {
  try {
    const cfg = loadConfig({ create: false })
    return { cfg }
  } catch (e) {
    return { error: `尚未初始化：${e.message}` }
  }
}

export function apply(ctx) {
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args || {}, exec))
      } catch (e) {
        return { ok: false, error: `${e.name || 'Error'}: ${e.message}` }
      }
    },
  }))

  tool({
    name: 'memory_search',
    description: '检索会话记忆库：按标签/关键词/日期/工作区返回目录项、文件路径和命中片段（不返回全文）。',
    parameters: {
      tag: { type: 'string', description: '标签，例如 视频 / 运维 / 代码' },
      keyword: { type: 'string', description: '关键词（默认按子串匹配）' },
      date: { type: 'string', description: '精确日期 YYYY-MM-DD' },
      since: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      until: { type: 'string', description: '结束日期 YYYY-MM-DD' },
      workspace: { type: 'string', description: '工作区标题或路径片段' },
      limit: { type: 'number', description: '最多返回条数，默认 10' },
      regex: { type: 'boolean', description: 'keyword 按正则解释' },
      deep: { type: 'boolean', description: '同时搜索 .json 的完整工具输出' },
    },
    async execute(args) {
      const { cfg, error } = cfgOrError()
      if (error) return { ok: false, error }
      const results = search(cfg, {
        tag: args.tag || null, keyword: args.keyword || null, date: args.date || null,
        since: args.since || null, until: args.until || null, workspace: args.workspace || null,
        limit: Number(args.limit || 10), regex: !!args.regex, deep: !!args.deep,
      })
      return { ok: true, count: results.length, results }
    },
  })

  tool({
    name: 'memory_read',
    description: '按轮次读取会话原文（只读指定范围；工具结果超过 4096 字节会截断）。',
    parameters: {
      file: { type: 'string', description: 'memory_search 返回的 .md 或 .json 路径' },
      turn_from: { type: 'number', description: '起始轮次（含）' },
      turn_to: { type: 'number', description: '结束轮次（含）' },
    },
    async execute(args) {
      const { cfg, error } = cfgOrError()
      if (error) return { ok: false, error }
      if (!args.file) return { ok: false, error: '缺少 file' }
      const from = Number(args.turn_from || 0)
      const to = Number(args.turn_to || from)
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        return { ok: false, error: 'turn_from / turn_to 必须是正整数且 from <= to' }
      }
      const text = readRange(cfg, String(args.file), from, to)
      return { ok: true, file: String(args.file), turn_from: from, turn_to: to, text }
    },
  })

  tool({
    name: 'memory_backup_now',
    description: '立刻生成加密备份并走已配置的上传通道（smtp/webhook/local_only）。',
    parameters: {
      kind: { type: 'string', description: 'daily（默认）或 weekly' },
      upload: { type: 'boolean', description: '是否上传，默认按配置' },
    },
    async execute(args) {
      const { cfg, error } = cfgOrError()
      if (error) return { ok: false, error }
      const { secrets } = await loadSecrets(cfg)
      if (!secrets) return { ok: false, error: '密钥库不可读，请先运行 dsh-memory-archive init' }
      const kind = args.kind === 'weekly' ? 'weekly' : 'daily'
      const upload = args.upload === undefined ? cfg.uploader.type !== 'local_only' : !!args.upload
      const rec = await backupNow(cfg, secrets, { kind, upload })
      return {
        ok: true, name: rec.name, path: rec.path, size: rec.size, sha256: rec.sha256,
        parts: rec.parts, upload: rec.upload,
      }
    },
  })

  tool({
    name: 'memory_status',
    description: '查看记忆库状态：归档数、最近扫描/备份、密钥库、上传通道、定时任务。',
    parameters: {},
    async execute() {
      const { cfg, error } = cfgOrError()
      if (error) return { ok: false, error, hint: '先运行 dsh-memory-archive init' }
      return await getStatus(cfg)
    },
  })

  let scheduler = null
  try {
    const cfg = loadConfig({ create: false })
    if (cfg?.installed) scheduler = startScheduler(cfg)
  } catch { /* 未初始化时插件仍可用，工具会提示先 init */ }

  const dispose = () => { try { scheduler?.stop?.() } catch {} }
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  else if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
}
