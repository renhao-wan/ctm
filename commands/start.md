---
description: 启动一个离线的托管会话
argument-hint: <会话名>
allowed-tools: mcp__plugin_ctm_ctm__ctm_start
---

调用 `ctm_start` 工具，`name` 取 `$ARGUMENTS` 的第一个词。

```text
$ARGUMENTS
```

如果工具返回「会话已在运行」，直接告诉用户，不要重复启动。如果返回启动失败，把原因如实转述，不要臆测会话已经就绪。
