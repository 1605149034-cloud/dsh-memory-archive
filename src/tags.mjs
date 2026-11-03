const STOPWORDS = new Set(`
的 了 和 是 在 我 有 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这
那 他 她 它 们 我们 你们 他们 这个 那个 这些 那些 什么 怎么 为什么 因为 所以 但是 而且 以及
对于 关于 如果 虽然 然后 现在 已经 还是 就是 可以 需要 应该 可能 进行 通过 使用 一个 一些
时候 问题 东西 任务 工作 文件 内容 情况 地方 方式 方法 结果 开始 结束 今天 明天 昨天
用户 助手 系统 消息 回复 说 做 让 给 被 把 从 向 跟 与 及 或 并 并且 而 则 其 之 于 为 以
path file files text type content md json html css js ts true false null none python exe dll api
id url http https www com cn org net ok error cwd stdout stderr returncode exit code input output
user assistant system session memory archive wav mp3 m4a flac ogg png jpg jpeg gif svg pdf docx
the a an and or but if then else for to of in on at by with from as is are was were be been
this that these those it its you your we our i me my he she they them not no yes can could
should would will just do does did have has had into over under about more most some any
`.split(/\s+/).filter(Boolean))

const BLOCK = new Set([
  'path', 'file', 'files', 'text', 'type', 'content', 'md', 'json', 'html', 'css', 'js',
  'true', 'false', 'null', 'none', 'python', 'exe', 'dll', 'api', 'id', 'url', 'http',
  'https', 'www', 'com', 'cn', 'org', 'net', 'ok', 'error', 'cwd', 'stdout', 'stderr',
  'returncode', 'exit', 'code', 'input', 'output', 'wav', 'mp3', 'm4a', 'flac', 'ogg',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'docx', 'users', 'pc',
])

let segmenter = null
try {
  segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
} catch {}

function goodToken(raw) {
  const t = String(raw || '').trim().toLowerCase()
  if (t.length < 2) return false
  if (STOPWORDS.has(t) || BLOCK.has(t)) return false
  if (/^[\d_+\-.]+$/.test(t)) return false
  if (/^[a-z]$/.test(t)) return false
  if (/^[a-z0-9]+$/.test(t) && t.length < 3) return false
  return true
}

export function tokenize(text) {
  const s = String(text || '').slice(0, 400_000)
  const out = []
  if (segmenter) {
    for (const seg of segmenter.segment(s)) {
      const t = seg.segment.trim()
      if (seg.isWordLike && goodToken(t)) out.push(/^[a-z0-9]+$/i.test(t) ? t.toLowerCase() : t)
    }
  } else {
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.+-]{1,}|[\u4e00-\u9fff]{2,}/g)) {
      const t = m[0]
      if (goodToken(t)) out.push(/^[a-z0-9]+$/i.test(t) ? t.toLowerCase() : t)
    }
  }
  return out
}

/**
 * 对一组切片文本做 TF-IDF，返回每个切片的关键词。
 * 语料就是同一个会话的所有日切片；不需要联网、不花 token。
 */
export function keywordsForSlices(sliceTexts, topK = 8) {
  const docs = sliceTexts.map((t) => tokenize(t))
  const n = docs.length || 1
  const df = new Map()
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1)
  }
  return docs.map((doc) => {
    const tf = new Map()
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1)
    const scored = []
    for (const [t, c] of tf.entries()) {
      const idf = Math.log((n + 1) / ((df.get(t) || 1) + 1)) + 1
      scored.push([t, c * idf])
    }
    scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const out = []
    for (const [t] of scored) {
      if (!out.includes(t)) out.push(t)
      if (out.length >= topK) break
    }
    return out
  })
}

export function applyRules(text, rules) {
  const s = String(text || '')
  const tags = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    const tag = String(rule?.tag || '').trim()
    const pattern = String(rule?.pattern || '').trim()
    if (!tag || !pattern) continue
    try {
      if (new RegExp(pattern, 'i').test(s) && !tags.includes(tag)) tags.push(tag)
    } catch {}
  }
  return tags
}

export function buildTags(text, workspace, rules, keywords) {
  const tags = []
  for (const t of applyRules(text, rules)) if (!tags.includes(t)) tags.push(t)
  if (workspace && !tags.includes(workspace)) tags.push(workspace)
  for (const k of (keywords || []).slice(0, 3)) {
    if (k && !tags.includes(k) && String(k).length >= 2) tags.push(k)
  }
  return tags
}

export function tagTextForRounds(data, rounds) {
  const parts = [data.title || '', data.first_ask || '']
  for (const r of rounds) {
    for (const it of r.items || []) {
      if (it.role === 'user' || it.role === 'system' || it.role === 'assistant') {
        if (it.text) parts.push(it.text)
      }
    }
  }
  return parts.join('\n').slice(0, 400_000)
}
