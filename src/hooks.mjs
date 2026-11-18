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
  return { hooks };
}

export function writeSettings({ dir, name, eventsFile }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(buildSettings({ name, eventsFile }), null, 2));
  return file;
}
