// M1 冒烟测试：宿主启动 → 状态机就绪 → 注入一条消息 → 收到 Stop。
//
// 不走 CLI（CLI 需要 TTY 转发），直接实例化 Session，
// 验证 M1 的核心闭环，并检查 hook 事件是否完整落盘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';

const CTM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-smoke-'));
// 注册表与收件箱走 CTM_HOME；不设置会写进真实的 ~/.ctm
process.env.CTM_HOME = CTM_DIR;
// 不要用本仓库作为 cwd：仓库自带 .mcp.json，会触发 MCP server 确认，需要用户按键。
const CWD = process.env.M1_CWD || path.join(os.tmpdir(), 'ctm-smoke-cwd');
fs.mkdirSync(CWD, { recursive: true });
const NAME = 'smoke';
const EVENTS = path.join(CTM_DIR, 'events', `${NAME}.jsonl`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEvents() {
  try {
    return fs
      .readFileSync(EVENTS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const timeline = [];
const started = Date.now();
const session = new Session({
  name: NAME,
  cwd: CWD,
  ctmDir: CTM_DIR,
  settleMs: 3000,
  onStatus: (s) => {
    const t = ((Date.now() - started) / 1000).toFixed(1);
    timeline.push(`${t}s ${s}`);
    console.log(`  [${t}s] status=${s}`);
  },
  onExit: (code) => console.log(`  session exited code=${code}`),
});

console.log(`CTM_DIR=${CTM_DIR}`);
console.log(`claude=${session.bin} (${session.binVia})`);

// 等 idle
const readyDeadline = Date.now() + 120000;
while (Date.now() < readyDeadline && session.status !== 'idle') await sleep(250);

if (session.status !== 'idle') {
  console.log(`RESULT=M1_NOT_READY status=${session.status}`);
  console.log(`SCREEN_TAIL=${session.screen.text().slice(-800)}`);
  session.stop();
  process.exit(1);
}

await sleep(500);
const injectedAt = Date.now();
const r = await session.inject('Reply with exactly M1-HOST-OK');
console.log(`inject ok=${r.ok} reason=${r.reason || '-'} cost=${Date.now() - injectedAt}ms`);

// 注入后不能立刻回到 idle：bootstrap 的 settled 曾经每轮 tick 覆盖 busy，
// 这里等 500ms 验证状态没有被启动状态机抢回去。
await sleep(500);
const stayedBusy = session.status === 'busy';
console.log(`stayedBusy=${stayedBusy} status=${session.status}`);

// 等 Stop
let stops = 0;
const stopDeadline = Date.now() + 120000;
while (Date.now() < stopDeadline) {
  stops = readEvents().filter((e) => e.hook === 'Stop').length;
  if (stops > 0) break;
  await sleep(500);
}

const events = readEvents();
const byHook = {};
for (const e of events) byHook[e.hook] = (byHook[e.hook] || 0) + 1;
const stopEv = events.find((e) => e.hook === 'Stop');
const answer = stopEv?.payload?.last_assistant_message || '';

console.log('\n=== 事件统计 ===');
for (const [k, v] of Object.entries(byHook)) console.log(`  ${k}: ${v}`);
console.log(`last_assistant_message=${JSON.stringify(answer.slice(0, 200))}`);
console.log(`timeline=${timeline.join(' → ')}`);

const checks = [
  ['inject 被接受', r.ok],
  ['注入后状态保持 busy（未被启动状态机覆盖）', stayedBusy],
  ['收到 Stop hook', stops > 0],
  ['Stop 带 last_assistant_message', !!answer],
  ['回答包含 M1-HOST-OK', /M1-HOST-OK/i.test(answer)],
  ['SessionStart 触发', !!byHook.SessionStart],
  ['UserPromptSubmit 触发', !!byHook.UserPromptSubmit],
];

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);

const allOk = checks.every(([, ok]) => ok);
console.log(`\nRESULT=${allOk ? 'M1_SMOKE_OK' : 'M1_SMOKE_PARTIAL'}`);

session.stop();
setTimeout(() => process.exit(allOk ? 0 : 1), 500);
