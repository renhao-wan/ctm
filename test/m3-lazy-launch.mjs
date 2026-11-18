// M3 端到端：B 的会话没开，A 发消息时由 A 负责把 B 拉起来。
//
// 验证链路：
//   离线 meta → enqueue → launchSession(background) → 新宿主启动 claude
//   → 自动从收件箱补投 → 模型回复 → Stop hook
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchSession } from '../src/launch.mjs';
import { enqueue, readDelivered } from '../src/inbox.mjs';
import { writeMeta, readMeta, sessionDir } from '../src/registry.mjs';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-m3-'));
process.env.CTM_HOME = CTM_HOME;
process.env.CTM_LAUNCH_MODE = 'background';

const CWD = process.env.M3_CWD || path.join(os.tmpdir(), 'ctm-smoke-cwd');
fs.mkdirSync(CWD, { recursive: true });
const NAME = 'lazy';
const ENTRY = path.resolve('src/main.mjs');
const EVENTS = path.join(CTM_HOME, 'events', `${NAME}.jsonl`);
const HOST_LOG = path.join(sessionDir(NAME), 'host.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tailLog() {
  try {
    const lines = fs.readFileSync(HOST_LOG, 'utf8').split('\n');
    return lines.slice(-20).join('\n');
  } catch {
    return '(无 host.log)';
  }
}

// 一个"之前配置过、现在没开窗口"的会话
writeMeta(NAME, {
  name: NAME,
  pid: null,
  cwd: CWD,
  node: process.execPath,
  entry: ENTRY,
  settleMs: 3000,
  status: 'offline',
  exitedAt: new Date().toISOString(),
});

const msg = enqueue({
  to: NAME,
  from: 'sender',
  fromCwd: 'D:/projects/web',
  text: 'Reply with exactly LAUNCH-OK',
  kind: 'ask',
});
console.log(`enqueued ${msg.id}`);

const r = launchSession(NAME);
console.log(`launch started=${r.started} mode=${r.mode || '-'} reason=${r.reason || '-'}`);
if (!r.started) {
  console.log(`RESULT=M3_LAUNCH_FAIL reason=${r.reason}`);
  process.exit(1);
}

const launchedAt = Date.now();
let stop = null;
let cameOnline = false;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const meta = readMeta(NAME);
  if (meta?.pid && meta.status !== 'offline') cameOnline = true;
  try {
    const evs = fs
      .readFileSync(EVENTS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    stop = evs.find((e) => e.hook === 'Stop');
    if (stop) break;
  } catch {
    // 事件文件还没建
  }
  await sleep(500);
}

const answer = stop?.payload?.last_assistant_message || '';
const delivered = readDelivered(NAME).has(msg.id);
const checks = [
  ['被拉起的宿主拿到了新 PID', cameOnline],
  ['模型被自动补投的消息触发', !!stop],
  ['回答包含 LAUNCH-OK', /LAUNCH-OK/i.test(answer)],
  ['消息被标记为已投递', delivered],
];
console.log(`\n发起启动到收到应答 ${((Date.now() - launchedAt) / 1000).toFixed(1)}s`);

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
const allOk = checks.every(([, ok]) => ok);
if (!allOk) console.log(`\n--- host.log 末尾 ---\n${tailLog()}`);
console.log(`\nRESULT=${allOk ? 'M3_LAZY_LAUNCH_OK' : 'M3_LAZY_LAUNCH_FAIL'}`);

// 收尾：结束被拉起的宿主
const meta = readMeta(NAME);
if (meta?.pid) {
  try {
    execFileSync('taskkill', ['/PID', String(meta.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 已退出
  }
}
setTimeout(() => process.exit(allOk ? 0 : 1), 500);
