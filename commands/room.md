---
description: 组内讨论频道：列出、创建、发言、发起一轮、汇总
argument-hint: <list|create|say|show|start|summary> <频道> [内容]
allowed-tools: mcp__plugin_ctm_ctm__ctm_room
---

调用 `ctm_room` 工具。

参数解析（`$ARGUMENTS`）：

- `list`：`action=list`，不需要其他参数
- `create <频道> <议题>`：`action=create`，`room` 是频道名，`topic` 是议题
- `say <频道> <内容>`：`action=say`，`room` 是频道名，`text` 是发言
- `show <频道>`：`action=show`，`room` 是频道名
- `start <频道> [本轮议题]`：`action=start`，`text` 可选；不带时沿用频道议题
- `summary <频道>`：`action=summary`，`room` 是频道名

```text
$ARGUMENTS
```

频道绑定组：`create` 不传 `group` 时自动取当前会话的组。`start` 只把议题投递到同组、且对当前会话可见的成员，不会跨组扩散。

把工具结果如实告诉用户。`start` 只是把议题写入成员收件箱，不代表成员已经发言；要看到观点用 `show` 或 `summary`。
