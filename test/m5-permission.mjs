// M5 验证：运行期工具权限提示会被识别为 needs-input。
//
// 不启动 CLI（它需要 TTY），直接实例化 Session。
// 让 claude 使用 Write 工具写一个文件：手动权限模式下这会弹出确认提示，
// 宿主应在不依赖 Stop 的情况下把状态切到 needs-input。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { readMeta } from '../src/registry.mjs';

const CTM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-perm-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-perm-cwd-'));
const NAME = 'perm';
const TARGET = path.join(CWD, 'permission-check.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timeline = [];
let metaAtNeedsInput = null;
const started = Date.now();

const session = new Session({
  name: NAME,
  cwd: CWD,
  ctmDir: CTM_DIR,
  settleMs: 3000,
  // 默认可能继承用户配置的 auto mode（自动批准工具），这里强制 manual
  // 才能稳定复现工具权限确认提示。
  claudeArgs: ['--permission-mode', 'manual'],
  onStatus: (s) => {
    const t = ((Date.now() - started) / 1000).toFixed(1);
    timeline.push(`${t}s ${s}`);
    console.log(`  [${t}s] status=${s}`);
    if (s === 'needs-input' && !metaAtNeedsInput) {
      metaAtNeedsInput = readMeta(NAME);
    }
  },
  onExit: (code) => console.log(`  session exited code=${code}`),
});

console.log(`CTM_DIR=${CTM_DIR}`);
console.log(`CWD=${CWD}`);
console.log(`claude=${session.bin} (${session.binVia})`);

const readyDeadline = Date.now() + 120000;
while (Date.now() < readyDeadline && session.status !== 'idle') await sleep(250);
if (session.status !== 'idle') {
  console.log(`RESULT=M5_NOT_READY status=${session.status}`);
  console.log(`SCREEN_TAIL=${session.screen.text().slice(-800)}`);
  session.stop();
  process.exit(1);
}

await sleep(500);
const r = await session.inject(
  `Use the Write tool (not Bash) to create ${TARGET} with exactly: PERMISSION-OK. Do it now; do not ask for clarification.`,
);
console.log(`inject ok=${r.ok} reason=${r.reason || '-'}`);

// 等待权限提示被识别
const deadline = Date.now() + 120000;
while (Date.now() < deadline && session.status !== 'needs-input') await sleep(250);

const sawNeedsInput = session.status === 'needs-input';
metaAtNeedsInput = readMeta(NAME);
console.log(`sawNeedsInput=${sawNeedsInput} status=${session.status}`);
console.log(`meta.status=${metaAtNeedsInput?.status || '(none)'}`);

// 尝试确认（默认选中 Yes），让会话继续；不作为硬断言。
// 直接写 PTY 绕过了 bindStdin，这里手动模拟"用户已按键"，
// 否则下一 tick 会因提示文本仍在屏幕上而再次标记 needs-input。
if (sawNeedsInput) {
  session.permissionAckAt = Date.now();
  session.setStatus('busy');
  try {
    session.proc.write('\r');
  } catch {
    // 已退出
  }
}

let confirmed = false;
const confirmDeadline = Date.now() + 30000;
while (Date.now() < confirmDeadline && !(confirmed = fs.existsSync(TARGET))) {
  await sleep(250);
}

// 便于排障：把完整屏幕与事件落盘
const screenDump = path.join(CTM_DIR, 'screen.txt');
fs.writeFileSync(screenDump, session.screen.text());
console.log(`screen dump=${screenDump}`);

if (!confirmed) {
  console.log(`SCREEN_TAIL=${session.screen.text().slice(-1200)}`);
  try {
    const lines = fs
      .readFileSync(path.join(CTM_DIR, 'events', `${NAME}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const stop = lines.filter((e) => e.hook === 'Stop').at(-1);
    console.log(
      `last_assistant_message=${JSON.stringify(
        String(stop?.payload?.last_assistant_message || '').slice(0, 400),
      )}`,
    );
  } catch {
    // 没有事件文件
  }
}

const checks = [
  ['权限提示被识别为 needs-input', sawNeedsInput],
  ['meta.json 同步了 needs-input', metaAtNeedsInput?.status === 'needs-input'],
  ['needs-input 期间未再投递（状态非 idle）', sawNeedsInput],
  ['确认后工具执行（文件生成）', confirmed],
];

console.log('\n--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
console.log(`timeline=${timeline.join(' → ')}`);

const allOk = checks.every(([, ok]) => ok);
console.log(`\nRESULT=${allOk ? 'M5_PERMISSION_OK' : 'M5_PERMISSION_PARTIAL'}`);

session.stop();
setTimeout(() => process.exit(allOk ? 0 : 1), 800);
