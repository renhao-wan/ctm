// 由 Claude Code 的 hook 调用：把 stdin 的 JSON 原样追加到事件文件。
// 参数：node hook-probe.cjs <HookName> <SessionName> <EventsFile>
const fs = require('fs');
const path = require('path');

const [, , hook, name, file] = process.argv;
const chunks = [];

process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    payload = { parse_error: e.message, raw };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), hook, name, payload }) + '\n');
  } catch {
    // hook 失败不能影响 claude 本身
  }
});
