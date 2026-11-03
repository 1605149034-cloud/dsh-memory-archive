# 内置调度触发证据

- 时间：2026-11-03 19:28（本地时区）
- 环境：临时 `DSH_HOME`，1 个合成会话，`uploader=local_only`
- 配置：`schedule.enabled=true`，`dailyAt` 设为当前分钟
- 动作：启动插件内置 `startScheduler()`，不建任何系统计划任务

实际日志（`archive/logs/schedule.log`）：

```text
- 2026-11-03 19:28:07 scheduler on：daily=19:28 weekly=23:59 day=0
- 2026-11-03 19:28:07 trigger daily
- 2026-11-03 19:28:07 done daily: scan processed=1 slices=1 backup=2026-11-03.zip upload=skipped
```

同一时刻 `archive/state.json` 的 `last_scan`：

```json
{
  "at": "2026-11-03 19:28:07",
  "target_date": "2026-11-03",
  "mode": "incremental",
  "stats": {
    "scanned": 1,
    "processed": 1,
    "skipped_unchanged": 0,
    "skipped_hash": 0,
    "skipped_not_today": 0,
    "skipped_empty": 0,
    "skipped_old": 0,
    "skipped_no_file": 0,
    "skipped_scope": 0,
    "skipped_stat_error": 0,
    "written_files": 2,
    "slices": 1,
    "total_sessions": 1
  }
}
```

判定：`schedule.log` 有 `trigger daily` / `done daily`，`state.last_scan.at` 与触发时间一致，说明调度器不是摆设。
