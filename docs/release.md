# 发布记录

- 包名：`dsh-memory-archive`
- 版本：`0.1.0`
- 包名可用性：`npm view dsh-memory-archive` 返回 `E404`（截至 2026-11-03，尚未被占用）
- npm 链接（发布后生效）：https://www.npmjs.com/package/dsh-memory-archive
- 安装命令：`npm i -g dsh-memory-archive`
- 发布状态：**未发布**。`npm whoami` 返回 `E401 Unauthorized`，本机 `.npmrc` 里的 token 已失效；需要用户重新 `npm login` 后再执行 `npm publish --access public`。
- 最终 tgz：由 `npm pack` 生成，路径与 sha256 记录在交付说明/黑板（包内不写自身哈希，避免自引用）

## 发布前检查

```bash
npm test
npm pack --dry-run
npm pack
tar -tzf dsh-memory-archive-0.1.0.tgz
```

解包后做私有信息扫描：**扫描关键词只放在本机临时脚本/环境变量里，不要写进包内任何文件**。
重点确认包里没有邮箱地址、授权码、备份密码、私有绝对路径、真实会话 id/标题。

## 干净环境验收

1. 新建空目录，`npm i <tgz>`
2. `npx dsh-memory-archive init --non-interactive ...`（密钥用环境变量，不落 argv）
3. `npx dsh-memory-archive archive --backfill 30`
4. `npx dsh-memory-archive backup`
5. 从邮箱下载回加密包，sha256 与记录一致
6. `npx dsh-memory-archive selftest --check-upload`
7. 卸载后无系统计划任务、无常驻进程

（验收输出见交付说明；本文件只记录发布信息。）

## 本轮验收记录（2026-11-03）

- `npm view dsh-memory-archive`：`E404`，包名可用
- `npm test`：9 个测试全过（help 优先/配置读写/增量跳过/加密往返/分卷命名/SMTP 失败/退避重试/插件四工具注册/密钥目录独立）
- `npm pack --dry-run`：30 个文件，约 46.8 kB；`tar -tzf` 可见 `index.js`、`cli.js`、`cli.mjs`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/*`
- 解包私有信息扫描：邮箱、授权码、备份密码、私有绝对路径、真实会话 id/标题 **0 命中**
- 三项复检修复：`init --help` 优先；密钥目录固定 `DSH_MEMORY_ARCHIVE_HOME/.private`（含旧路径迁移，改归档目录后仍可读）；`cordis.patch.yml` 为 UTF-8 无 BOM；内置调度触发证据见 `docs/scheduler-evidence.md`
- 干净目录只装 tgz：
  - `import 'dsh-memory-archive'` 导出 `apply / inject / name`
  - `npx dsh-memory-archive --version` → `0.1.0`
  - `init`（local_only）→ `archive` → `backup` → `selftest --offline`：PASS
  - `init`（smtp，真实自寄）→ `backup` → `selftest --check-upload`：PASS，`downloadSha256` 与本地一致
- `cleanup --purge --yes` 删除归档/备份/配置；`npm uninstall` 后包目录不存在
- 无系统计划任务（内置调度只在 DSH 进程内运行；触发日志见 `docs/scheduler-evidence.md`）

## Node 版与 Python 版

- Node 版：npm 发布版（本包）
- Python 版：内部参考实现，不发布
- 差异见 `docs/diff.md`
