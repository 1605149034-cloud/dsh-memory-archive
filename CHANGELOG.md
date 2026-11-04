## 0.1.5

- **内容与 0.1.4 完全相同**（只有版本号不同）。原因是一次误判导致的重复发布：
  0.1.4 发出后，`npm publish` 用了新的**暂存 + 异步落地**流程（bypass-2FA token 现在走这条路），
  落地前约 1~7 分钟里，查 registry 读到的是旧值、`npm stage list` 也看不到暂存记录，
  于是被误判成“没发出去”，换了个版本号重发 → 0.1.4 与 0.1.5 并存。
  **0.1.4 已 deprecated，请用 0.1.5。**
- 教训（写给下次）：`npm publish` 成功后**不要立刻查 registry 下结论**。
  新版是真异步落地的，正确做法是按版本直查 `https://registry.npmjs.org/<pkg>/<ver>`
  轮询到 200 为止（最多等 8 分钟）；不要用 packument 的 `npm view <pkg> version`，
  它更容易吃到 CDN 缓存。

## 0.1.4

- **修：注入的地址会指向空目录**。`addressText()` 原来只判 `existsSync(archive.dir)`，
  而 `archive.dir` 默认是 `~/.dsh/memory-archive`（`init` 过就存在，里面只有一个 `config.json`），
  于是它会把「总目录 …/index.md」「跨天索引 …/tags.json」两条**并不存在**的路径写进系统提示词 ——
  正是 0.1.3 注释里说要避免的「塞一条指不到东西的路径」。
  改为判 `existsSync(indexFilePath(cfg))`：有 `index.md` 才算真扫过一遍。
  > 2026-11-04 实测：改前 `archive.dir` 存在=true、`index.md`/`tags.json` 存在=false；
  > 改后注入的是真数据目录，且 `memory_search` 用它的配置直接能检到历史轮次。
- 本机 `archive.dir` 已指向 `D:\工作区\阿深私聊\记忆库`（与同机的 Python 版共用同一份数据）。
  两侧的切片命名（`<工作区>--<会话>.md`）、`index.md` 结构、`tags.json`
  （`{generated_at,count,tags}`）一致，已双向交叉验证可互读，不会各存一份。
  > 注意：`state.json` 是 JS 版自己的扫描状态，Python 版用 `归档状态.json`，两者并存互不影响。

## 0.1.3

- **常驻注入「存档在哪」**：插件现在会往系统提示词里加一段（`memory-archive-address`，静态、排在最末尾），
  写明存档目录、`index.md`、`tags.json`，以及「跨天找一件事靠标签不靠日期、标签命不中就退回全文搜」。
  - 为什么必须有：只注册工具不够。压缩（`/compact`）会把对话收成摘要，摘要不会替你记住这份存档存在；
    压缩后的会话不知道有这个目录，就永远不会调用 `memory_search` —— 装了等于没装。
    注入段每轮重新拼进上下文，压缩碰不到它。
  - 用 `section` 而不是 `context`：这段是静态文本，定型后一直命中缓存；`context` 每轮都按新消息算钱。
  - 归档目录不存在时不注入（没 `init` 过就不该往别人提示词里塞一条指不到东西的路径）；
    目录被清掉/换机会自动卸载。

## 0.1.1

- docs: README 补「init → archive → selftest → backup」的首次使用顺序，并说明空数据下 selftest 报红属正常
- doctor: 明确打印实际使用的 sessions 目录，便于排查「换盘/换 DSH_HOME 后归档 0 条」

# Changelog

## 0.1.0

首个可分发版本。

- 首次运行向导：归档范围、incremental/full、SMTP/Webhook/local_only、授权码隐藏输入、备份密码 ≥16 位
- 健康检查：SMTP 登录 + 自寄 + IMAP 回取 + 解密 + sha256 比对，全绿才标记 installed
- 归档：只读 DSH sessions，按天切片，增量跳过未变化会话
- 检索：本地分词 + TF-IDF 关键词，`memory_search` / `memory_read` 只返回片段/指定轮次
- 备份：ZIP AES-256，超过 50MB 自动分卷，SMTP 回取校验，失败退避重试 + 告警
- 插件：注册 `memory_search` / `memory_read` / `memory_backup_now` / `memory_status`
- 调度：插件内置每日/每周调度，不写系统计划任务
- 密钥：Windows DPAPI 优先；其他平台 0600 文件权限 + 明确警告
- 零私有信息：包内不包含任何邮箱、授权码、备份密码、私有路径或真实会话数据
