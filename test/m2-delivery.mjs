// M2 端到端：宿主从收件箱主动取出消息并注入，模型回复，Stop 回来。
//
// 验证的是"主动送达"这条链路：
//   外部进程 enqueue → 宿主 pumpInbox → 两步写入 → 模型处理 → Stop
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { enqueue, readDelivered } from '../src/inbox.mjs';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-m2-'));
process.env.CTM_HOME = CTM_HOME;
const CWD = process.env.M2_CWD || path.join(os.tmpdir(), 'ctm-smoke-cwd');
fs.mkdirSync(CWD, { recursive: true });
const NAME = 'recv';
const EVENTS = path.join(CTM_HOME, 'events', `${NAME}.jsonl`);
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

const session = new Session({
  name: NAME,
  cwd: CWD,
  ctmDir: CTM_HOME,
  settleMs: 3000,
  onStatus: (s) => console.log(`  status=${s}`),
  onExit: (code) => console.log(`  session exited code=${code}`),
});

const readyDeadline = Date.now() + 120000;
while (Date.now() < readyDeadline && session.status !== 'idle') await sleep(250);
if (session.status !== 'idle') {
  console.log(`RESULT=M2_NOT_READY status=${session.status}`);
  session.stop();
  process.exit(1);
}

console.log('host idle, enqueue message');
const msg = enqueue({
  to: NAME,
  from: 'sender',
  fromCwd: 'D:/projects/web',
  text: 'Reply with exactly DELIVERY-OK',
  kind: 'ask',
});

let stop = null;
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  stop = readEvents().find((e) => e.hook === 'Stop');
  if (stop) break;
  await sleep(500);
}

const answer = stop?.payload?.last_assistant_message || '';
const delivered = readDelivered(NAME).has(msg.id);
const checks = [
  ['收到 Stop hook', !!stop],
  ['回答包含 DELIVERY-OK', /DELIVERY-OK/i.test(answer)],
  ['消息被标记为已投递', delivered],
];

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
const allOk = checks.every(([, ok]) => ok);
console.log(`\nRESULT=${allOk ? 'M2_DELIVERY_OK' : 'M2_DELIVERY_FAIL'}`);

session.stop();
setTimeout(() => process.exit(allOk ? 0 : 1), 500);
