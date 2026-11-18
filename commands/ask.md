---
description: 向另一个托管会话提问
argument-hint: <会话名> <问题>
allowed-tools: mcp__plugin_ctm_ctm__ctm_ask
---

调用 `ctm_ask` 工具。

参数解析：`$ARGUMENTS` 的第一个词是目标会话名 `to`，其余全部内容是 `text`（保留原始换行）。

```text
$ARGUMENTS
```

调用后把工具返回的结果原样告诉用户。消息只是写入对方收件箱，对方空闲时才会送达，不要把"已写入"说成"已答复"。
