# Node 发布版 vs Python 参考实现

- **Node 版（`dsh-memory-archive`）**：本 npm 包。发布形态，DSH 插件 + CLI，跨平台，插件内置调度。
- **Python 版（`memory_archive`）**：内部参考实现，用于格式验证与本机自用；不随 npm 发布。

## 能力对照

| 能力 | Node 发布版 | Python 参考版 | 说明 |
|---|---|---|---|
| 读取多帧 zstd JSONL | `node:zlib` | `zstandard` | 都能处理多帧 |
| 按天切片 | 是 | 是 | 同一套 front matter |
| 增量跳过 | size + mtime | size + mtime | 都不读未变化文件 |
| 中文分词 | `Intl.Segmenter` | jieba | Node 无原生分词依赖，质量略低但零安装 |
| 标签规则 | `tag_rules.json` | `tag_rules.json` | 默认规则不同；都可改 |
| 检索 | `search` / `read` | `search` / `read` | Node 只搜 `.md`，`--deep` 可搜 `.json` |
| 备份格式 | ZIP AES-256 | 7z AES-256 | 都可用 7-Zip 打开；Node 版不依赖 7z 二进制 |
| 分卷 | >50MB | >40MB | Node 版按发布任务书用 50MB |
| SMTP 上传 | nodemailer | smtplib | 都做 IMAP 回取 sha256 |
| Webhook | 是 | 否 | Node 版新增 |
| local_only | 是 | 否 | Node 版新增 |
| 首次运行向导 | 交互 + 非交互 | 参数式 | Node 版新增 |
| 密钥保护 | Windows DPAPI / 0600 | ACL 收紧 | Node 版优先 DPAPI |
| 定时 | 插件内置 | Windows 计划任务 | Node 版不写系统任务 |
| DSH 工具 | 四个工具 | CLI | Node 版为发布形态 |
| 审批/权限 | 无额外要求 | 无额外要求 | 都只读 sessions |

## 不兼容点（升级/迁移必读）

1. **备份文件名**：Node 版是 `YYYY-MM-DD.zip`（ZIP AES-256）；Python 版是 `YYYY-MM-DD.zip.7z`（7z AES-256）。
   两种都能用 7-Zip 打开，但扩展名不同，脚本不要写死后缀。
2. **状态文件**：Node 版 `state.json`；Python 版 `归档状态.json`。互不读取；换实现时需要重新全量归档。
3. **默认数据目录**：Node 版 `~/.dsh/memory-archive/`；Python 版由用户配置为工作区内目录。
4. **摘要**：两版都未启用 LLM 摘要；`summary` 为空。
5. **标签默认值**：Node 版用通用规则（代码/视频/运维/AI）；Python 版是自用规则。发布版不内置个人化标签。
