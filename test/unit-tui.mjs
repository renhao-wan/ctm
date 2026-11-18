// TUI 状态机单元测试（不启动 PTY）
import assert from 'node:assert/strict';
import {
  Bootstrap,
  isReadyText,
  normalize,
  READY_MARKERS,
  isMcpPrompt,
  trustSelection,
  TRUST_SELECTION,
} from '../src/tui.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

const norm = (s) => normalize(s);

// 两个版本的实际屏幕片段
const SCREEN_234 = `
╭──────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                 │
╰──────────────────────────────────────────╯
──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ? for shortcuts · ← for agents
`;

const SCREEN_319 = `
──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

check('2.1.234 屏幕判定就绪', () => assert.equal(isReadyText(norm(SCREEN_234)), true));
check('2.1.319 屏幕判定就绪', () => assert.equal(isReadyText(norm(SCREEN_319)), true));
check('启动画面不算就绪（无状态栏）', () => assert.equal(isReadyText(norm('✻ Welcome to Claude Code\n❯')), false));
check('只有状态栏没有提示符不算就绪', () =>
  assert.equal(isReadyText(norm('? for shortcuts')), false));

// 2.1.319 实测：默认选中 No, exit。直接回车会让 claude 以 code=1 退出。
const SCREEN_TRUST = `
Quick safety check: Is this a project you created or one you trust?
❯ No, exit
  Yes, I trust this folder
Enter to confirm · Esc to cancel
`;

const SCREEN_TRUST_YES = `
Quick safety check: Is this a project you created or one you trust?
  No, exit
❯ Yes, I trust this folder
Enter to confirm · Esc to cancel
`;

check('信任提示默认选中 No 时先下移，且按键有节流', () => {
  assert.equal(trustSelection(norm(SCREEN_TRUST)), TRUST_SELECTION.NO);
  const b = new Bootstrap({ settleMs: 0 });
  assert.equal(b.step(norm(SCREEN_TRUST)), 'trust-down');
  assert.equal(b.trustAnswered, false);
  // 节流：立刻重复调用不会再按键
  assert.equal(b.step(norm(SCREEN_TRUST)), 'waiting');
  // 800ms 后仍未变成 Yes，说明按键被吞，再下移一次
  b.lastTrustKeyAt = Date.now() - 900;
  assert.equal(b.step(norm(SCREEN_TRUST)), 'trust-down');
});

check('屏幕选中 Yes 且按键稳定后才回车', () => {
  assert.equal(trustSelection(norm(SCREEN_TRUST_YES)), TRUST_SELECTION.YES);
  const b = new Bootstrap({ settleMs: 0 });
  assert.equal(b.step(norm(SCREEN_TRUST_YES)), 'enter');
  assert.equal(b.trustAnswered, true);
  // 同一个提示重复出现不再回答
  assert.notEqual(b.step(norm(SCREEN_TRUST_YES)), 'enter');
});

check('刚按过方向键时不立刻回车', () => {
  const b = new Bootstrap({ settleMs: 0 });
  b.trustDowns = 1;
  b.lastTrustKeyAt = Date.now();
  assert.equal(b.step(norm(SCREEN_TRUST_YES)), 'waiting');
  b.lastTrustKeyAt = Date.now() - 600;
  assert.equal(b.step(norm(SCREEN_TRUST_YES)), 'enter');
});

check('信任提示布局无法识别时不猜按键', () => {
  const b = new Bootstrap({ settleMs: 0 });
  // 有信任提示文本但没有可识别的选中项
  const screen = norm('Is this a project you created or one you trust?\nYes, I trust this folder');
  assert.equal(b.step(screen), 'trust-unknown');
  assert.equal(b.trustAnswered, false);
});

check('fullscreen 提示选择 not now', () => {
  const b = new Bootstrap({ settleMs: 0 });
  assert.equal(b.step(norm('Try the new fullscreen renderer?\n1. Yes, try it\n2. Not now')), 'not-now');
});

// 项目自带 .mcp.json 时出现；MCP server 可执行任意代码，不能代用户按回车
const SCREEN_MCP = `
New MCP server found in this project: ctm
MCP servers may execute code or access system resources. All tool calls require approval.
❯ Use this MCP server
  Use this and all future MCP servers in this project
  Continue without using this MCP server
Enter to confirm · Esc to cancel
`;

check('MCP server 确认提示交给用户处理', () => {
  assert.equal(isMcpPrompt(norm(SCREEN_MCP)), true);
  const b = new Bootstrap({ settleMs: 0 });
  assert.equal(b.step(norm(SCREEN_MCP)), 'needs-input');
});

check('MCP 提示关闭后可以继续启动', () => {
  const b = new Bootstrap({ settleMs: 0 });
  assert.equal(b.step(norm(SCREEN_MCP)), 'needs-input');
  assert.equal(b.step(norm(SCREEN_319)), 'ready');
});

check('MCP 历史文本不会让会话永远停在 needs-input', () => {
  // 提示关闭后，旧文本仍留在累积缓冲前部；只检查屏幕末尾
  const longTail = 'x'.repeat(3000);
  assert.equal(isMcpPrompt(norm(`${SCREEN_MCP}\n${longTail}`)), false);
});

check('就绪后需要 settle', () => {
  const b = new Bootstrap({ settleMs: 50 });
  assert.equal(b.step(norm(SCREEN_234)), 'ready');
  assert.equal(b.step(norm(SCREEN_234)), 'waiting');
  const until = Date.now() + 120;
  while (Date.now() < until) {
    // 模拟 tick
  }
  assert.equal(b.step(norm(SCREEN_234)), 'settled');
});

check('未知屏幕最终超时', () => {
  const b = new Bootstrap({ settleMs: 0, timeoutMs: 10 });
  assert.equal(b.step(norm('something unexpected')), 'waiting');
  const until = Date.now() + 30;
  while (Date.now() < until) {
    // 模拟等待
  }
  assert.equal(b.step(norm('something unexpected')), 'timeout');
});

check('ANSI 转义被清洗后仍可匹配', () => {
  const raw = 'Yes,\x1b[12GI\x1b[14Gtrust\x1b[20Gthis\x1b[25Gfolder';
  assert.equal(norm(raw).includes('trustthisfolder'), true);
});

check('标记列表覆盖两个版本', () => {
  assert.ok(READY_MARKERS.includes('?forshortcuts'));
  assert.ok(READY_MARKERS.includes('⏵⏵automode'));
  assert.ok(READY_MARKERS.includes('←foragents'));
});

console.log(`\n${fail === 0 ? 'RESULT=UNIT_OK' : 'RESULT=UNIT_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
