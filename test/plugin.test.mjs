import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
