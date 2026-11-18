// MCP server 单元测试：走真实 stdio JSON-RPC，但不启动 claude。
// 重点是插件暴露的工具与离线拉起的返回语义。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-mcp-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-mcp-cwd-'));
process.env.CTM_HOME = CTM_HOME;

const { writeMeta } = await import('../src/registry.mjs');
const { enqueue, readInbox } = await import('../src/inbox.mjs');

const RECORD = path.join(WORK, 'argv.json');
const FAKE_ENTRY = path.join(WORK, 'fake-entry.mjs');
fs.writeFileSync(
  FAKE_ENTRY,
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify(process.argv.slice(2)));\n`,
);

writeMeta('lazy', {
  name: 'lazy',
  pid: null,
  cwd: WORK,
  node: process.execPath,
  entry: FAKE_ENTRY,
  settleMs: 2000,
  status: 'offline',
});
writeMeta('busy', {
  name: 'busy',
  pid: process.pid,
  cwd: WORK,
  status: 'idle',
});
enqueue({ to: 'lazy', from: 'x', text: '第一条' });
enqueue({ to: 'lazy', from: 'x', text: '第二条' });

const MCP = path.resolve('src/mcp-server.mjs');
const proc = spawn(process.execPath, [MCP], {
  cwd: path.dirname(MCP),
  env: { ...process.env, CTM_HOME, CTM_LAUNCH_MODE: 'background', CTM_SESSION_NAME: 'sender-a' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
proc.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));

const pending = new Map();
createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const cb = pending.get(msg.id);
  if (cb) {
    pending.delete(msg.id);
    cb(msg);
  }
});

let seq = 1;
function rpc(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC 超时：${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args });
  const r = msg.result;
  const text = r?.content?.[0]?.text ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 结果
  }
  return { isError: !!r?.isError, text, parsed };
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

let tools = [];
await check('initialize 返回 ctm 服务信息', async () => {
  const r = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(r.result.serverInfo.name, 'ctm');
});

await check('tools/list 暴露 5 个工具', async () => {
  const r = await rpc('tools/list', {});
  tools = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['ctm_ask', 'ctm_list', 'ctm_start', 'ctm_status', 'ctm_tell']);
});

await check('ctm_list 显示离线会话与未读数', async () => {
  const { parsed } = await call('ctm_list', {});
  const lazy = parsed.find((s) => s.名称 === 'lazy');
  const busy = parsed.find((s) => s.名称 === 'busy');
  assert.equal(lazy.状态, 'offline');
  assert.equal(lazy.未读, 2);
  assert.equal(busy.状态, 'idle');
  assert.equal(busy.未读, 0);
});

await check('ctm_tell 对离线目标会入队并尝试拉起', async () => {
  const { isError, parsed } = await call('ctm_tell', { to: 'lazy', text: '唤醒一下' });
  assert.equal(isError, false);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target.launched, true);
  assert.match(parsed.note, /正在启动目标会话/);
});

await check('拉起使用 meta 里记录的入口与参数', async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(RECORD)) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(RECORD), '假入口未被执行');
  const argv = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  assert.deepEqual(argv, ['new', 'lazy', '--cwd', WORK, '--settle', '2000']);
});

await check('消息发送方身份取 CTM_SESSION_NAME', async () => {
  const inbox = readInbox('lazy');
  const last = inbox[inbox.length - 1];
  assert.equal(last.from, 'sender-a');
  assert.equal(last.kind, 'tell');
});

await check('锁生效期间重复启动返回启动中', async () => {
  const { isError, text } = await call('ctm_start', { name: 'lazy' });
  assert.equal(isError, true);
  assert.match(text, /launching|启动中/);
});

await check('ctm_start 未知会话报错', async () => {
  const { isError, text } = await call('ctm_start', { name: 'nobody' });
  assert.equal(isError, true);
  assert.match(text, /会话不存在/);
});

await check('ctm_ask 标记消息类型为 ask', async () => {
  const { parsed } = await call('ctm_ask', { to: 'busy', text: '在吗' });
  assert.equal(parsed.ok, true);
  const inbox = readInbox('busy');
  assert.equal(inbox[inbox.length - 1].kind, 'ask');
});

proc.stdin.end();
console.log(`\nRESULT=${fail === 0 ? 'MCP_OK' : 'MCP_FAIL'} pass=${pass} fail=${fail}`);
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
