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
