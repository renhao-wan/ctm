// M6 输入形态验证：中文、emoji、多行消息通过 PTY 写入后不被破坏。
//
// 说明：输入法（IME）的组合态由终端和输入法维护，不会出现在 PTY 的 stdin 中；
// ctm 收到的永远是已经提交的 UTF-8 字符。本测试验证提交后的多字节文本
// 在两步写入 + 回车提交的链路上保持完整，覆盖"中文输入法场景"的实际数据形态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { enqueue } from '../src/inbox.mjs';

const CTM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-unicode-'));
process.env.CTM_HOME = CTM_DIR;
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-unicode-cwd-'));
const NAME = 'unicode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = 'UNICODE-中文-🙂';
const session = new Session({
  name: NAME,
  cwd: CWD,
  ctmDir: CTM_DIR,
  settleMs: 3000,
  quiet: true,
  onExit: (c) => console.log(`exited ${c}`),
});

const readyDeadline = Date.now() + 120000;
while (Date.now() < readyDeadline && session.status !== 'idle') await sleep(250);
if (session.status !== 'idle') {
  console.log(`RESULT=UNICODE_NOT_READY status=${session.status}`);
  session.stop();
  process.exit(1);
}

const events = path.join(CTM_DIR, 'events', `${NAME}.jsonl`);
function stopCount() {
  try {
    return fs
      .readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.hook === 'Stop').length;
  } catch {
    return 0;
  }
}

// 多行 + 中文 + emoji：模拟输入法提交后的真实内容
enqueue({
  to: NAME,
  from: '用户',
  text: `请只回复这一行，不要加别的内容：${MARKER}\n第二行只是测试多行输入。`,
  kind: 'ask',
});

const before = stopCount();
const deadline = Date.now() + 120000;
while (Date.now() < deadline && stopCount() === before) await sleep(500);

let answer = '';
try {
  const stops = fs
    .readFileSync(events, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.hook === 'Stop');
  answer = String(stops.at(-1)?.payload?.last_assistant_message || '');
} catch {
  // 没有事件
}

const ok = answer.includes(MARKER);
console.log(`answer=${JSON.stringify(answer.slice(0, 200))}`);
console.log(`\n--- checks ---`);
console.log(`${ok ? 'PASS' : 'FAIL'} 中文与 emoji 在写入链路中完整保留`);
console.log(`RESULT=${ok ? 'M6_UNICODE_OK' : 'M6_UNICODE_FAIL'}`);

session.stop();
setTimeout(() => process.exit(ok ? 0 : 1), 800);
