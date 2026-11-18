---
description: 回复收件箱里的某条消息
argument-hint: <消息短 id> <回复内容>
allowed-tools: mcp__plugin_ctm_ctm__ctm_reply
---

调用 `ctm_reply` 工具。

参数解析：`$ARGUMENTS` 的第一个词是消息 id（消息前缀里 `#` 后面的 8 位，或完整 id），其余全部内容是 `text`。

```text
$ARGUMENTS
```

消息前缀形如 `[来自会话 web，工作区 D:/projects/web · #7f3a1c2d] …`，其中 `#7f3a1c2d` 就是可回复的 id。

如果工具提示「这条消息来自用户本人」，说明这条消息不是别的会话发来的，直接把情况告诉用户，不要编造一个回复对象。
