import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../index.js'

test('插件入口：注册四个 DSH 工具', () => {
  const root = mkdtempSync(join(tmpdir(), 'dma-plugin-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, '.dsh')
  try {
    const tools = []
    const ctx = { tools: { register: (t) => { tools.push(t); return t } } }
    assert.equal(name, 'memory-archive')
    assert.deepEqual(inject, ['tools'])
    apply(ctx)
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['memory_backup_now', 'memory_read', 'memory_search', 'memory_status'])
    for (const t of tools) assert.equal(typeof t.execute, 'function')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('常驻注入：地址写进系统提示词，压缩也丢不掉', () => {
  const root = mkdtempSync(join(tmpdir(), 'dma-inject-'))
  const dsh = join(root, '.dsh')
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  try {
    // 归档目录里有了 index.md = 真的扫过一遍，这时才该注入地址
    // （只判目录存在是不够的：init 完的目录里只有一个 config.json，见下一条用例）
    mkdirSync(join(dsh, 'memory-archive'), { recursive: true })
    writeFileSync(join(dsh, 'memory-archive', 'index.md'), '# 会话记忆库 · 总目录\n', 'utf8')
    const sections = []
    let tick = null
    const agent = {
      session: { id: 'sess-1' },
      ctx: {
        systemPrompt: {
          section: (spec) => {
            sections.push(spec)
            return () => { spec.disposed = true }
          },
        },
      },
    }
    const ctx = {
      tools: { register: (t) => t },
      agents: { list: () => [agent] },
      effect: (fn) => fn(),
      interval: (fn) => { tick = fn; return () => { tick = null } },
    }
    apply(ctx)
    assert.equal(typeof tick, 'function', '应该挂上轮询')

    tick()
    assert.equal(sections.length, 1, '每个 agent 挂一次')
    const spec = sections[0]
    assert.equal(spec.name, 'memory-archive-address')
    // 纯文本：不能让宿主当模板解析（记忆/路径里出现 {{ }} 会炸整间会话）
    assert.equal(spec.interpolate, false)
    // 必须排在 DSH 自己的段（一直排到 10200）之后，否则一变就废掉后面几千字缓存
    assert.ok(spec.order > 10200, 'order 要排在宿主段之后')
    assert.ok(spec.text.includes(join(dsh, 'memory-archive')), '正文里要有存档目录')
    assert.ok(spec.text.includes('tags.json'), '要提到跨天标签索引')
    assert.ok(spec.text.includes('memory_search'), '要告诉它用什么工具查')

    tick()
    assert.equal(sections.length, 1, '同一帧重复 tick 不该重复挂载')

    // 数据被清掉（index.md 没了）→ 注入要能自己撤掉，
    // 不能一直挂着指路到一个不存在的总目录
    rmSync(join(dsh, 'memory-archive', 'index.md'), { force: true })
    tick()
    assert.equal(spec.disposed, true, 'index.md 不存在时应卸载注入')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(root, { recursive: true, force: true })
  }
})

test('目录在但没有 index.md（只 init 过、没扫过）→ 不注入', () => {
  const root = mkdtempSync(join(tmpdir(), 'dma-empty-'))
  const dsh = join(root, '.dsh')
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  try {
    // 0.1.4 之前的真实故障：init 过的目录里只有 config.json，
    // 旧判据只看目录在不在 → 照样注入一条 index.md / tags.json 都不存在的地址
    mkdirSync(join(dsh, 'memory-archive'), { recursive: true })
    writeFileSync(join(dsh, 'memory-archive', 'config.json'), '{}', 'utf8')

    const sections = []
    let tick = null
    const agent = {
      session: { id: 'sess-empty' },
      ctx: { systemPrompt: { section: (spec) => { sections.push(spec); return () => { spec.disposed = true } } } },
    }
    apply({
      tools: { register: (t) => t },
      agents: { list: () => [agent] },
      effect: (fn) => fn(),
      interval: (fn) => { tick = fn; return () => { tick = null } },
    })
    tick()
    assert.equal(sections.length, 0, '只有配置、没有 index.md 时不该往系统提示词里塞地址')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    rmSync(root, { recursive: true, force: true })
  }
})
