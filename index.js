/**
 * dsh-memory-archive —— DSH 插件 host 入口。
 * 纯 Node；不依赖 Python、不依赖本机私有路径。
 * 工具：memory_search / memory_read / memory_backup_now / memory_status
 */
import { existsSync } from 'node:fs'

import { loadConfig, archiveDir, indexFilePath, tagsFilePath } from './src/config.mjs'
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

  // ── 常驻注入：「原始存档在哪、怎么查」 ──────────────────────────────────────
  //
  // 为什么非有不可（2026-11-04 的真实事故）：
  //   只注册工具是不够的。压缩（/compact）会把对话收成摘要，而摘要**不会**替你记住
  //   「这台机器上还有一份按天切片的原始存档」。压缩后的会话根本不知道有这个目录，
  //   就永远不会去用 memory_search —— 插件装了等于没装。
  //   那次能找回归档，纯靠压缩前的交接里写了一句路径；摘要里没这句 = 不知道存在。
  //
  // 所以地址必须**长在插件自己身上**：这段每轮重新拼进系统提示词，压缩碰不到它。
  //
  // 用 section 而不是 context（两条路 DSH 都给了，选错会烧钱）：
  //   这段是**静态文本** —— 只随配置变，不随对话变。静态段定型后一直命中缓存；
  //   换成 context 会在对话末尾追加，每轮都按新消息算钱。
  //   （反向的例子是「记忆内容」那种每轮都变的东西，那个才该用 context。）
  //
  // order 排在 DSH 自己的段之后（DSH 的段一直排到 10200）：排在中间的话，
  //   一旦这段变了，后面几千字全变缓存未命中。
  const INJECT_NAME = 'memory-archive-address'
  const INJECT_ORDER = 89995

  function addressText() {
    let cfg
    try {
      cfg = loadConfig({ create: false })
    } catch {
      return null // 还没 init：没什么可说的，别往别人的提示词里塞半截话
    }
    const dir = archiveDir(cfg)
    // 判「有没有真数据」看 index.md，**不看目录存不存在**：
    //   archive.dir 默认落在 ~/.dsh/memory-archive，而这个目录只要 init 过就存在
    //   （里面只有一个 config.json）。光判目录，等于把
    //   「总目录 …/index.md」「跨天索引 …/tags.json」两条并不存在的路径塞进系统提示词 ——
    //   正是这段注释上面说的「塞一条指不到东西的路径」。
    // 2026-11-04 实测：archive.dir 存在=true，index.md/tags.json 存在=false，
    //   而真数据在另一个目录。改判 index.md 之后才真正对应「扫过一遍」。
    if (!existsSync(indexFilePath(cfg))) return null
    return [
      '【会话记忆库】除了本会话的上下文，这台机器上还有一份「按天切片的会话原文存档」：',
      `  存档目录：${dir}`,
      `  总目录：${indexFilePath(cfg)}`,
      `  跨天索引：${tagsFilePath(cfg)}（标签 → 日期 + 会话）`,
      '查法：memory_search（标签/关键词/日期）→ memory_read（按轮次读原文）；也可以直接检索存档目录。',
      '**找一件横跨好几天的事，按标签查，别只按日期查** —— 同一个问题往往散在好几天的切片里。',
      '注意：标签是从文本自动抽取的，内容散而杂的那天会变弱；标签命不中就退回关键词/全文搜，',
      '别把「搜不到」当成「不存在」。',
    ].join('\n')
  }

  function sessionIdOf(agent) {
    const s = agent && agent.session
    if (!s) return ''
    for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      try {
        const v = s[k]
        if (typeof v === 'string' && v) return v
      } catch { /* 拿不到就试下一个 */ }
    }
    return ''
  }

  const mounted = new Map() // sid -> { agent, text, off }
  let warned = false

  function unmount(sid) {
    const cur = mounted.get(sid)
    if (!cur) return
    // ⚠ systemPrompt.section() 返回的是**一个函数**（Cordis 的 effect disposer），
    //   不是 { off() } 对象 —— 写成 cur.off?.() 会永远卸不掉。
    try {
      if (typeof cur.off === 'function') cur.off()
    } catch { /* 宿主已经收走了 */ }
    mounted.delete(sid)
  }

  function syncAgents() {
    let list = []
    try {
      if (ctx.agents && typeof ctx.agents.list === 'function') list = ctx.agents.list() || []
    } catch { return }
    if (!list.length) return
    const text = addressText()
    for (const agent of list) {
      const sid = sessionIdOf(agent)
      if (!sid) continue
      if (!text) { unmount(sid); continue }
      const cur = mounted.get(sid)
      // agent 实例会被换掉（会话重开 / 插件重载 / 宿主重建），实例变了就得重挂
      if (cur && cur.agent === agent && cur.text === text) continue
      unmount(sid)
      try {
        const sp = agent && agent.ctx && agent.ctx.systemPrompt
        if (!sp || typeof sp.section !== 'function') continue
        const off = sp.section({ name: INJECT_NAME, order: INJECT_ORDER, interpolate: false, text })
        mounted.set(sid, { agent, text, off })
      } catch (e) {
        if (!warned) {
          warned = true
          try { console.warn('[memory-archive] 注入挂不上：' + (e && e.message)) } catch { /* 无所谓 */ }
        }
      }
    }
  }

  // 宿主不一定给 timer / effect（比如单测里的假 ctx）：拿不到就静默不注入，
  // **不能让注入把整个插件拖挂** —— 四个工具才是主功能。
  let stopInject = null
  try {
    if (typeof ctx.effect === 'function' && typeof ctx.interval === 'function') {
      stopInject = ctx.effect(() => ctx.interval(() => { try { syncAgents() } catch { /* 下一拍再试 */ } }, 1000))
    }
  } catch { /* 没有定时器就算了 */ }

  let scheduler = null
  try {
    const cfg = loadConfig({ create: false })
    if (cfg?.installed) scheduler = startScheduler(cfg)
  } catch { /* 未初始化时插件仍可用，工具会提示先 init */ }

  const dispose = () => {
    try { scheduler?.stop?.() } catch { /* 已经停了 */ }
    try { if (typeof stopInject === 'function') stopInject() } catch { /* 宿主已经收走了 */ }
    for (const sid of [...mounted.keys()]) unmount(sid)
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  else if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
}
