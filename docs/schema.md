# DSH 会话数据结构（发布版 schema，已脱敏）

> 本文只描述格式，不含任何真实会话 id、工作区路径、邮箱或对话内容。
> 示例中的 `<uuid>`、`<workspace>`、`<date>` 都是占位符。

## 1. 目录

```text
$DSH_HOME/
  sessions/
    --<encoded-workspace-path>--/
      session-<uuid>/
        session.v4.jsonl.zstd
  storages/
    workspace.json
```

- 每个会话目录通常只有 1 个 `session.v4.jsonl.zstd`。
- 第一层目录名是工作区路径编码；**不要从目录名反推路径**（`-` 同时表示分隔符和原字符，编码不可逆）。
  会话文件第一条 `session` 事件里的 `cwd` 才是可靠路径。
- `workspace.json` 实际位置是 `$DSH_HOME/storages/workspace.json`；部分旧版本可能在 `$DSH_HOME/workspace.json`，插件会两个都试。

## 2. 文件格式

- `session.v4.jsonl.zstd` 是 **多帧 zstd 拼接**；每次追加事件追加一个 zstd 帧。
- 用流式解压读取全部帧；只解第一帧会丢后面的事件。
- 解压后是 UTF-8 JSONL，一行一个事件。
- 读取时文件尾部可能正在写入；流式读取遇到尾部截断时保留已解出的完整行。

## 3. 事件外壳

```json
{"type":"user/message","seq":2,"time":1700000000000,"data":{}}
```

| 字段 | 说明 |
|---|---|
| `type` | 事件类型 |
| `seq` | 会话内序号（部分事件可能被压缩标记为 shadowed，但行仍在文件里） |
| `time` | 毫秒 Unix 时间戳 |
| `data` | 各类型自己的负载 |

排序按文件行序；需要显式排序时用 `seq`。

## 4. 会话头 `session`

```json
{"type":"session","version":4,"id":"session-<uuid>",
 "createdAt":1700000000000,"cwd":"<absolute-workspace-path>",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

会话短 id 取 UUID 前 8 位。

## 5. 用户消息 `user/message`

```json
{"type":"user/message","seq":2,"time":1700000000000,
 "data":{"content":[{"type":"text","text":"..."}],
         "source":{"kind":"user"},"role":"user"}}
```

`source.kind` 实测包括：

- 真人：`user`、`qq`
- 系统提示：`watch-together`、`schedule`、`user-approval`
- 脚手架（归档时跳过）：`runtime-context`、`time-context`、`skill-catalog`、
  `agent-instructions`、`tool-jobs`、`compact-checkpoint`、`goal`、`tool-goal`、
  `repeat-tool-reminder`、`agent-message`、`subagent-settled`、`working-directory`

内容块：

```json
{"type":"text","text":"..."}
{"type":"image","attachment":{"attachmentId":"sha256:...","mediaType":"image/png",
 "width":660,"height":315,"bytes":56538,"name":"image.png"}}
```

图片只记元数据，不复制图片本体。

## 6. 助手消息 `assistant/message`

```json
{"type":"assistant/message","seq":3,"time":1700000000000,
 "data":{"message":{"role":"assistant","content":[
   {"type":"reasoning","text":"..."},
   {"type":"tool-call","id":"call_...","name":"read","arguments":"{\"file_path\":\"...\"}"}
 ]},"usage":{...}}}
```

- `text` 是给用户的最终文字。
- `reasoning` 是内部推理，归档不存（只统计长度）。
- `tool-call.arguments` 是 JSON 字符串。

## 7. 工具调用与结果

```json
{"type":"tool/call","data":{"callId":"call_...","name":"read","arguments":"{...}"}}
{"type":"tool/result","data":{"toolCallId":"call_...",
 "message":{"role":"tool","content":[{"type":"text","text":"..."}]}}}
```

- 工具结果可能很大：`.md` 中单条超过 4096 字节截断并标记，`.json` 保留完整文本。
- 工具结果也可能包含 `image` 块，同样只记元数据。

## 8. 标题与压缩

```json
{"type":"session/title","data":{"title":"...","source":{"kind":"provider"}}}
{"type":"compaction/summary","data":{"summary":[{"type":"text","text":"..."}]}}
```

- 标题取该会话最后一条 `session/title`。
- `compaction/summary` 是上下文压缩摘要；`.json` 保留，`.md` 只放最近两条的前 2000 字。
- `compaction/prune` 只标记被压缩遮蔽的 seq，不删原文。

## 9. 日期与轮次

- 时间戳是毫秒；日期按用户本地时区（`config.timezone`，默认 `local`）切。
- 归档的「轮」按真人用户消息分组：一条真人用户消息开启一轮，后续助手文本/工具调用/结果都归这一轮。
- 跨天轮次归到起始日；会话按天切片，读整段时按日期文件串起来。

## 10. 归档字段

| 字段 | 来源 |
|---|---|
| `date` | 轮次起始日（本地时区） |
| `workspace` | `session.cwd` → `workspace.json` 的 `path → title`；查不到取路径末段 |
| `session` | 会话 id UUID 前 8 位 |
| `turns` | 本日切片轮次数 |
| `session_turns` | 全会话轮次数 |
| `first_ask` | 第一条真人用户文本，截断 80 字 |
| `summary` | 二期未启用 LLM 摘要，留空 |
| `tags` | 工作区名 + `tag_rules.json` 正则 + TF-IDF 关键词 |
| `keywords` | 本地分词 + TF-IDF（零 token） |
| `source_file` | 只读引用 `$DSH_HOME/sessions/...` |

## 11. 容错

- 空会话（只有 4 行策略事件）跳过。
- 解析失败的会话跳过并写告警，不伪造内容。
- 旧版本 `workspace.json` 缺字段时按空值处理。
- DSH 升级如果改变 `version` 或事件结构，插件会检测解析结果并在 `status` / 日志里提示。
