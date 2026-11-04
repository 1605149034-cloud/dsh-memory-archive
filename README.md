# dsh-memory-archive

## 首次使用顺序（很重要）

```text
dsh-memory-archive init        # 1. 配置邮箱/密码，跑健康检查
dsh-memory-archive archive     # 2. 先归档一次，生成切片
dsh-memory-archive selftest    # 3. 再自检；没归档时 selftest 会红，这是正常的
dsh-memory-archive backup      # 4. 加密备份并上传
```

> 空的归档目录下直接跑 selftest，第 4~6 项会 FAIL —— 不是装坏了，是还没有数据。


把 DSH 会话按天归档成可检索的「历史书」，并用 AES-256 加密备份到 SMTP、Webhook 或仅本地。
**纯 Node、可跨平台、零内置私有信息**：邮箱、授权码、备份密码都由首次运行向导由用户自己填。

## 三行安装

```bash
npm i -g dsh-memory-archive
dsh-memory-archive init
dsh-memory-archive archive --backfill 30
```

装在 DSH profile 里（插件形态）：

```bash
dsh plugin add dsh-memory-archive
# 装完重启一次 DSH（bundle 需要重启才组装）
```

## 它做什么

- **归档**：只读 `$DSH_HOME/sessions`，按「轮次起始日」切成 `~/.dsh/memory-archive/YYYY-MM-DD/工作区--会话短id.md|.json`
- **增量**：默认只处理有变动的会话；未变化会话用 `size + mtime` 跳过，不读内容；`--mode full` 可全量重扫
- **检索**：本地分词 + TF-IDF 提关键词（零 token）；`tags.json` / `index.md` 人类可读目录
- **备份**：ZIP **AES-256** 加密；超过 50MB 自动分卷；SMTP 上传后自动 IMAP 下载回来校验 sha256
- **通道**：`smtp`（默认）/ `webhook` / `local_only`，失败退避重试并写 `logs/alerts.log`
- **定时**：插件内置调度（每天 09:50、每周日 10:10），不写系统计划任务，卸载不留残留
  （实测触发日志与 `last_scan.at` 见 `docs/scheduler-evidence.md`）

## 首次运行向导（`init`）

一条命令走完：

1. 选归档范围（全部工作区 / 指定工作区）
2. 选模式（incremental / full）
3. 选上传通道（smtp / webhook / local_only）
4. 填 SMTP 主机、端口、账号、收件人（默认发给自己），IMAP 主机自动推导、可改
5. **单独输入授权码/应用密码，不回显**
6. **设置备份密码（≥16 位），提示「丢了备份就打不开」**
7. 自动健康检查：**SMTP 登录 → 自寄一封测试邮件 → IMAP 读回 → 解密 → sha256 比对**
8. 全绿才算 `installed=true`；失败会明确报错并保留配置供重试

非交互（CI / 脚本；密钥只从环境变量读，不落 argv）：

```bash
DMA_BACKUP_PASSWORD='...' DMA_SMTP_PASSWORD='...' \
dsh-memory-archive init --non-interactive --uploader smtp \
  --smtp-host smtp.qq.com --smtp-port 465 \
  --smtp-user me@example.com --smtp-to me@example.com
```

## QQ 邮箱的三道门槛

QQ 邮箱不是「登录密码 + SMTP 开关」这么简单，实测顺序是：

1. **必须用电脑网页版**（`mail.qq.com` 或新版 `wx.mail.qq.com`）。**手机 App 里没有这个入口**。
2. 先**绑定手机号码**；没绑手机时页面会提示「需要先绑定手机号码后才可以开启服务」。
   绑定入口在同一页的「账号设置 → 绑定手机号码」。
3. 进 **设置 → 账号与安全 →「安全设置」标签 → 页面底部「POP3/IMAP/SMTP/Exchange/CardDAV 服务（未开启）」→ 开启服务**。
   开启后生成授权码还要过一道**短信验证**：用绑定手机发送指定短信内容，网页点「我已发送」后才出码。
4. 把生成的**授权码**填进 `init` 的「授权码」提示，不要填 QQ 登录密码。

其他常见邮箱：

| 邮箱 | SMTP | IMAP | 说明 |
|---|---|---|---|
| QQ | `smtp.qq.com:465` | `imap.qq.com:993` | 用授权码；普通附件上限 50MB |
| 163 | `smtp.163.com:465` | `imap.163.com:993` | 用客户端授权密码 |
| Gmail | `smtp.gmail.com:465` | `imap.gmail.com:993` | 需开启两步验证并生成 App Password |
| Outlook | `smtp.office365.com:587` | `outlook.office365.com:993` | 587 用 STARTTLS；部分账号需 App Password |

## 命令

```bash
dsh-memory-archive init [--non-interactive] [--uploader smtp|webhook|local_only]
dsh-memory-archive archive [--backfill 30] [--date YYYY-MM-DD] [--mode incremental|full] [--verbose]
dsh-memory-archive backup [--kind daily|weekly] [--date YYYY-MM-DD] [--no-upload]
dsh-memory-archive search --tag 视频 --since 2026-01-01 --workspace 某工作区
dsh-memory-archive read --file <path> --from 1 --to 5
dsh-memory-archive status [--json]
dsh-memory-archive selftest [--offline] [--check-upload]
dsh-memory-archive doctor
dsh-memory-archive cleanup [--purge --yes]
```

`selftest` 默认检查本地配置/归档/检索/加密/备份；`--check-upload` 额外做一次真实 SMTP 发送 + IMAP 回取；
`--offline` 明确跳过网络检查并打印「不代表上传通道可用」。网络失败会 `[FAIL]` 并返回非 0，不静默成功。

## 作为 DSH 插件使用

安装后注册四个工具（参数与返回）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `memory_search` | `tag? keyword? date? since? until? workspace? limit? regex? deep?` | `{ok,count,results:[{date,workspace,session,title,round,file,tags,snippet}]}` |
| `memory_read` | `file, turn_from, turn_to` | `{ok,text}`，只读指定轮次 |
| `memory_backup_now` | `kind? upload?` | `{ok,name,path,size,sha256,parts,upload}` |
| `memory_status` | 无 | 归档数、最近扫描/备份、密钥库、上传通道、下次定时 |

插件入口 `index.js` 注册工具 + 启动内置调度 + 挂一段常驻注入；不常驻独立进程，不写系统计划任务。

**常驻注入（0.1.3 起，0.1.4 修判据）**：除了工具，插件还会往系统提示词末尾加一段「存档在哪」——
存档目录、`index.md`、`tags.json`，以及「跨天找一件事按标签查、标签命不中就退回全文搜」。
原因是**只注册工具不够**：压缩（`/compact`）会把对话收成摘要，摘要不会替你记住这份存档存在，
压缩后的会话不知道有它，就永远不会调用 `memory_search`。注入段每轮重新拼进上下文，压缩碰不到它。
没有 `index.md`（没 `init` 过、或还没扫过第一遍）时不注入；`index.md` 被清掉或换机时自动卸载。
> 判据是 `index.md` 存不存在，**不是目录**存不存在：`init` 完的目录里只有一个 `config.json`，
> 只看目录会把一条 `index.md` / `tags.json` 都不存在的地址塞进系统提示词（0.1.4 之前就是这个问题）。

卸载：在 DSH 插件面板移除即可；数据目录默认保留，想彻底删用 `dsh-memory-archive cleanup --purge --yes`。

## 数据与安全

- 默认归档目录：`~/.dsh/memory-archive/`（可在 `init` 里改）
- 配置：`~/.dsh/memory-archive/config.json`（不含密码）
- 密钥：`~/.dsh/memory-archive/.private/secrets.dpapi`（Windows DPAPI）或 `secrets.json`（仅文件权限 0600，向导会警告）
- 备份：`~/.dsh/memory-archive/backups/`；加密包为 `.zip`（AES-256，7-Zip / WinRAR 可打开）
- 只读 `$DSH_HOME/sessions`；不修改会话目录、不移动、不删除
- 上传前必加密；邮件正文不含密码；日志只记状态/sha256 前缀
- 包内不含任何邮箱、授权码、备份密码、私有路径或真实会话数据

## 跨平台

- Node.js ≥ 22.15（内置 zstd）；Windows / macOS / Linux 都可归档、检索、加密、SMTP/Webhook
- Windows 密钥用 DPAPI；macOS/Linux 无 DPAPI 时退化为 `chmod 600` 的明文密钥文件，并在 `init` 明确警告
- 定时用插件内置调度（DSH 在跑才会触发），不依赖 `schtasks` / `cron`
- 没有系统计划任务、没有开机自启、没有后台 daemon

## 与 Python 参考实现的关系

- **Node 版（本包）是发布版**：npm 安装、DSH 插件、跨平台、内置调度、可插拔 uploader
- **Python 版是内部参考实现**：用于本机自用与格式验证，不随 npm 发布
- 两者共享同一套数据格式（按天切片、front matter、tags.json、state.json）；Node 版已覆盖归档/检索/加密/上传/向导；
  Python 版的 `--deep` 搜索、7z 备份等差异在 `docs/diff.md` 列明，后续以 Node 版为准

## 三分钟上手（可直接贴到 B 站简介）

```text
【DSH 会话记忆库】把每天聊过的 DSH 会话自动存成可搜索的历史书，再加密备份到你自己的邮箱。
1) 装：npm i -g dsh-memory-archive
2) 初始化：dsh-memory-archive init  （选范围→选模式→填邮箱→输授权码→设备份密码，自动测通）
3) 归档：dsh-memory-archive archive --backfill 30
4) 检索：dsh-memory-archive search --tag 视频
5) 备份：dsh-memory-archive backup
QQ 邮箱要先在电脑网页版「账号与安全→安全设置」底部开 POP3/SMTP，先绑手机，生成授权码还要短信验证。
备份密码丢了就打不开，请自己离线抄一份。纯本地归档不上传；上传前 AES-256 加密。
```

## 已知限制

- DSH 会话格式可能随版本变化；解析失败会跳过该会话并写告警，不会伪造数据
- Webhook 通道没有统一的「下载回取」标准；若服务端不返回 sha256，只能标记 `sent`，不能算 `verified`
- macOS/Linux 的密钥保护依赖文件权限；没有 Windows DPAPI 等价实现时会在向导里明确警告
- 大归档（>50MB）会分卷；收件箱需能接收多封邮件

## License

MIT
