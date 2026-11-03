import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'

function asBlob(buf) {
  return new Blob([buf])
}

export async function createEncryptedZip(files, outPath, password, { encryptionStrength = 3 } = {}) {
  if (!password || password.length < 8) throw new Error('加密密码太短')
  mkdirSync(dirname(outPath), { recursive: true })
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    password,
    encryptionStrength,
    zipCrypto: false,
  })
  for (const f of files) {
    const abs = resolve(f.path)
    if (!existsSync(abs)) continue
    const arc = String(f.arcname || f.path).replace(/\\/g, '/')
    await writer.add(arc, new BlobReader(asBlob(readFileSync(abs))))
  }
  const blob = await writer.close()
  const buf = Buffer.from(await blob.arrayBuffer())
  writeFileSync(outPath, buf)
  return outPath
}

export async function listEncryptedZip(zipPath, password) {
  const reader = new ZipReader(new BlobReader(asBlob(readFileSync(zipPath))), { password })
  try {
    const entries = await reader.getEntries()
    return entries.map((e) => ({ filename: e.filename, size: e.uncompressedSize }))
  } finally {
    try { await reader.close() } catch {}
  }
}

export async function extractEncryptedZip(zipPath, password, outDir) {
  mkdirSync(outDir, { recursive: true })
  const reader = new ZipReader(new BlobReader(asBlob(readFileSync(zipPath))), { password })
  try {
    const entries = await reader.getEntries()
    for (const e of entries) {
      if (e.directory) continue
      const target = join(outDir, ...String(e.filename).split('/'))
      mkdirSync(dirname(target), { recursive: true })
      const blob = await e.getData(new BlobWriter())
      writeFileSync(target, Buffer.from(await blob.arrayBuffer()))
    }
    return entries.length
  } finally {
    try { await reader.close() } catch {}
  }
}

export async function verifyEncryptedZip(zipPath, password, expectedNames = null) {
  const reader = new ZipReader(new BlobReader(asBlob(readFileSync(zipPath))), { password })
  try {
    const entries = await reader.getEntries()
    if (!entries.length) throw new Error('zip 打开成功但文件列表为空')
    if (expectedNames && entries.length !== expectedNames.length) {
      throw new Error(`zip 文件数不符：${entries.length} != ${expectedNames.length}`)
    }
    // 必须真正解密一次；只读文件列表不会校验密码/CRC
    for (const e of entries) {
      if (e.directory) continue
      await e.getData(new BlobWriter())
    }
    return entries.map((e) => ({ filename: e.filename, size: e.uncompressedSize }))
  } finally {
    try { await reader.close() } catch {}
  }
}
