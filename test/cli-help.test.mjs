import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))

test('init --help 优先显示帮助，不执行 init', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dma-help-'))
  const home = join(tmp, '.dsh')
  try {
    const r = spawnSync(process.execPath, [join(root, '..', 'cli.mjs'), 'init', '--help'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      timeout: 30000,
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /用法|dsh-memory-archive/)
    assert.equal(existsSync(join(home, 'memory-archive', 'config.json')), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
