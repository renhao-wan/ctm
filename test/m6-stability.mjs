// M6 稳定性验证：同一会话连续多轮投递。
//
// 验证长时间使用中状态机不会退化：每轮都要从 idle 进入 busy、收到 Stop、
// 回到 idle，且消息不被重复投递。用连续 5 轮代替数小时的挂机，覆盖同一组
// 状态迁移路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { enqueue, pendingMessages, readDelivered } from '../src/inbox.mjs';

const ROUNDS = Number(process.env.M6_ROUNDS || 5);
const CTM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-stability-'));
process.env.CTM_HOME = CTM_DIR;
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-stability-cwd-'));
const NAME = 'stable';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const session = new Session({
  name: NAME,
  cwd: CWD,
  ctmDir: CTM_DIR,
  settleMs: 3000,
  quiet: true,
  onExit: (c) => console.log(`exited ${c}`),
});

const events = path.join(CTM_DIR, 'events', `${NAME}.jsonl`);
function stops() {
  try {
    return fs
      .readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.hook === 'Stop');
  } catch {
    return [];
  }
}

const readyDeadline = Date.now() + 120000;
while (Date.now() < readyDeadline && session.status !== 'idle') await sleep(250);
if (session.status !== 'idle') {
  console.log(`RESULT=STABILITY_NOT_READY status=${session.status}`);
  session.stop();
  process.exit(1);
}

let pass = 0;
const timings = [];
for (let i = 1; i <= ROUNDS; i++) {
  const before = stops().length;
  const started = Date.now();
  enqueue({
    to: NAME,
    from: '用户',
    text: `Reply with exactly SEQ-${i}. Do not use any tools.`,
    kind: 'ask',
  });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && stops().length === before) await sleep(500);

  const all = stops();
  const answer = String(all.at(-1)?.payload?.last_assistant_message || '');
  const ok = all.length > before && new RegExp(`SEQ-${i}`).test(answer);
  if (ok) pass++;
  const ms = Date.now() - started;
  timings.push(ms);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} 第 ${i} 轮 ${ms}ms status=${session.status} answer=${JSON.stringify(
      answer.slice(0, 60),
    )}`,
  );
}

// 投递后不应再有未投递消息残留（重复投递会以 duplicate 形式体现）
const leftover = pendingMessages(NAME, readDelivered(NAME)).length;
const noDup = leftover === 0;
if (noDup) pass++;
console.log(`${noDup ? 'PASS' : 'FAIL'} 收件箱无残留未投递消息（leftover=${leftover}）`);

const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
console.log(`\n平均每轮 ${Math.round(avg)}ms，成功 ${pass}/${ROUNDS + 1}`);
const allOk = pass === ROUNDS + 1;
console.log(`RESULT=${allOk ? 'M6_STABILITY_OK' : 'M6_STABILITY_PARTIAL'}`);

session.stop();
setTimeout(() => process.exit(allOk ? 0 : 1), 800);
