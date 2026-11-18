---
description: 向另一个托管会话发送通知
argument-hint: <会话名> <消息>
allowed-tools: mcp__ctm__ctm_tell
---

调用 `ctm_tell` 工具。

参数解析：`$ARGUMENTS` 的第一个词是目标会话名 `to`，其余全部内容是 `text`（保留原始换行）。

```text
$ARGUMENTS
```

调用后把工具返回的结果原样告诉用户，不要改写消息内容。
