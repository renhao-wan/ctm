// M6 并发验收：5 个会话同时启动，各自收到第一条消息。
//
// 这是设计验收第 7 条（首条送达率 ≥ 95%）的复现与回归测试。
// 已知问题：并发启动时 TUI 首帧重绘会覆盖写入，导致首条消息停在输入框。
// 测试只依赖公开接口：Session + enqueue + pumpInbox。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { enqueue } from '../src/inbox.mjs';

const N = Number(process.env.M6_N || 5);
const CTM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-m6-'));
process.env.CTM_HOME = CTM_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = [];
const timelines = new Map();
const t0 = Date.now();

for (let i = 1; i <= N; i++) {
  const name = `c${i}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `ctm-m6-cwd-${i}-`));
  timelines.set(name, []);
  const s = new Session({
    name,
    cwd,
    ctmDir: CTM_DIR,
    settleMs: 3000,
    quiet: true,
    onStatus: (st) => {
      timelines.get(name).push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${st}`);
    },
    onExit: (code) => console.log(`[m6] ${name} exited ${code}`),
  });
  sessions.push(s);
}

function readStops(name) {
  try {
    return fs
      .readFileSync(path.join(CTM_DIR, 'events', `${name}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.hook === 'Stop');
  } catch {
    return [];
  }
}

console.log(`[m6] 启动 ${N} 个会话…`);
const readyDeadline = Date.now() + 180000;
while (Date.now() < readyDeadline && sessions.some((s) => s.status !== 'idle')) await sleep(500);
const ready = sessions.filter((s) => s.status === 'idle').length;
console.log(`[m6] ${ready}/${N} 就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

if (ready !== N) {
  for (const s of sessions) {
    if (s.status !== 'idle') {
      console.log(`[m6] ${s.name} 未就绪 status=${s.status}`);
      console.log(`[m6] ${s.name} screen=${s.screen.text().slice(-400)}`);
    }
  }
  for (const s of sessions) s.stop();
  console.log('RESULT=M6_NOT_READY');
  process.exit(1);
}

// 同时投递：模拟所有会话在同一时刻收到第一条消息
for (let i = 1; i <= N; i++) {
  enqueue({
    to: `c${i}`,
    from: '用户',
    text: `Reply with exactly CONCURRENT-${i}. Do not use any tools.`,
    kind: 'ask',
  });
}
console.log('[m6] 已全部入队，等待各自的 Stop…');

const deadlines = new Map(sessions.map((s) => [s.name, Date.now() + 180000]));
const results = new Map();

while (true) {
  let pending = 0;
  for (let i = 1; i <= N; i++) {
    const name = `c${i}`;
    if (results.has(name)) continue;
    const stops = readStops(name);
    if (stops.length > 0) {
      const answer = String(stops.at(-1)?.payload?.last_assistant_message || '');
      results.set(name, answer);
      console.log(
        `[m6] ${name} 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）answer=${JSON.stringify(
          answer.slice(0, 80),
        )}`,
      );
    } else if (Date.now() > deadlines.get(name)) {
      results.set(name, null);
      console.log(`[m6] ${name} 超时 status=${sessions[i - 1].status}`);
      console.log(`[m6] ${name} screen=${sessions[i - 1].screen.text().slice(-400)}`);
    } else {
      pending++;
    }
  }
  if (pending === 0) break;
  await sleep(500);
}

let passed = 0;
console.log('\n--- checks ---');
for (let i = 1; i <= N; i++) {
  const name = `c${i}`;
  const answer = results.get(name);
  const ok = !!answer && new RegExp(`CONCURRENT-${i}`).test(answer);
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} 首条消息送达 ${ok ? '' : `answer=${JSON.stringify(answer)}`}`);
  console.log(`      timeline=${timelines.get(name).join(' → ')}`);
}

const rate = passed / N;
console.log(`\n送达率 ${passed}/${N} = ${(rate * 100).toFixed(0)}%（目标 ≥ 95%）`);
console.log(`RESULT=${rate >= 0.95 ? 'M6_CONCURRENT_OK' : 'M6_CONCURRENT_PARTIAL'}`);

for (const s of sessions) s.stop();
setTimeout(() => process.exit(rate >= 0.95 ? 0 : 1), 1000);
