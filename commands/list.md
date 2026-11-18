---
description: 列出当前分组可见的托管会话及其状态
allowed-tools: mcp__plugin_ctm_ctm__ctm_list
---

调用 `ctm_list` 工具，把返回的 JSON 按表格展示给用户。

只展示工具返回的内容，不要补充推测或额外解释。列表已经按分组过滤：只能看到同组会话。如果没有会话，说明"当前组内没有托管会话"，并提示用 `ctm new <名字> --group <组>` 启动。
