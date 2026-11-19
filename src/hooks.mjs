// 生成并维护每个会话的临时 hook 配置。
//
// 已验证：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd
// 在 PTY 托管的交互式会话中都会触发，字段完整。
// 事件统一落到 ~/.ctm/events/<session>.jsonl，宿主监听该文件即可，
// 不需要解析 transcript，也不需要命名管道。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'hook-probe.cjs');

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
];

/** 路径含空格时必须加引号；保留 Windows 反斜杠，hook 执行器对此更稳 */
function q(p) {
  return `"${p}"`;
}

/**
 * ctm 自己的 MCP 工具名。
 * 通过 --plugin-dir 加载时前缀是 mcp__plugin_ctm_ctm__，
 * 通过项目 .mcp.json 加载时前缀是 mcp__ctm__，两种都放行。
 */
const CTM_TOOLS = ['ctm_list', 'ctm_status', 'ctm_start', 'ctm_tell', 'ctm_ask', 'ctm_reply', 'ctm_room'];
const ALLOWED_TOOLS = CTM_TOOLS.flatMap((t) => [`mcp__plugin_ctm_ctm__${t}`, `mcp__ctm__${t}`]);

export function buildSettings({ name, eventsFile, nodeBin = process.execPath }) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `${q(nodeBin)} ${q(PROBE)} ${ev} "${name.replace(/"/g, '')}" ${q(eventsFile)}`,
          },
        ],
      },
    ];
  }
  // 这些工具只操作 ctm 自己的收件箱与频道，不碰用户项目文件；
  // 不放行的话每次 AI 调用都会弹权限确认，托管会话会卡在 needs-input。
  return { hooks, permissions: { allow: ALLOWED_TOOLS } };
}

export function writeSettings({ dir, name, eventsFile }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(buildSettings({ name, eventsFile }), null, 2));
  return file;
}
