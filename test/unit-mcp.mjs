// MCP server 单元测试：走真实 stdio JSON-RPC，但不启动 claude。
// 覆盖工具语义、分组可见性与离线拉起的返回。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-mcp-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-mcp-cwd-'));
process.env.CTM_HOME = CTM_HOME;

const { writeMeta } = await import('../src/registry.mjs');
const { enqueue, readInbox } = await import('../src/inbox.mjs');
const { createRoom, readRoom } = await import('../src/rooms.mjs');

const RECORD = path.join(WORK, 'argv.json');
const FAKE_ENTRY = path.join(WORK, 'fake-entry.mjs');
fs.writeFileSync(
  FAKE_ENTRY,
  `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify(process.argv.slice(2)));\n`,
);

// 发送方 a 属于 frontend
writeMeta('sender-a', { name: 'sender-a', pid: null, cwd: WORK, groups: ['frontend'], status: 'offline' });
writeMeta('lazy', {
  name: 'lazy',
  pid: null,
  cwd: WORK,
  node: process.execPath,
  entry: FAKE_ENTRY,
  settleMs: 2000,
  groups: ['frontend'],
  claudeArgs: ['--resume', 'abc123'],
  status: 'offline',
});
writeMeta('busy', { name: 'busy', pid: process.pid, cwd: WORK, groups: ['frontend'], status: 'idle' });
writeMeta('outsider', { name: 'outsider', pid: process.pid, cwd: WORK, groups: ['backend'], status: 'idle' });
writeMeta('orphan', { name: 'orphan', pid: process.pid, cwd: WORK, groups: [], status: 'idle' });
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
  const chunks = (r?.content || []).map((c) => c.text).filter((t) => t != null);
  const text = chunks[0] ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 结果
  }
  return { isError: !!r?.isError, text, parsed, extra: chunks.slice(1) };
}

/** 以人（没有 CTM_SESSION_NAME）的身份调用一次，使用独立的 MCP 进程。 */
function callAsHuman(name, args) {
  const input =
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    ].join('\n') + '\n';
  const env = { ...process.env, CTM_HOME, CTM_LAUNCH_MODE: 'background' };
  delete env.CTM_SESSION_NAME;
  const out = execFileSync(process.execPath, [MCP], {
    cwd: path.dirname(MCP),
    env,
    input,
    encoding: 'utf8',
    timeout: 15000,
  });
  const msg = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((m) => m.id === 2);
  const r = msg.result;
  const text = (r?.content || []).map((c) => c.text).filter((t) => t != null)[0] ?? '';
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

await check('initialize 返回 ctm 服务信息', async () => {
  const r = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(r.result.serverInfo.name, 'ctm');
});

await check('tools/list 暴露 7 个工具', async () => {
  const r = await rpc('tools/list', {});
  const tools = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'ctm_ask',
    'ctm_list',
    'ctm_reply',
    'ctm_room',
    'ctm_start',
    'ctm_status',
    'ctm_tell',
  ]);
});

await check('ctm_list 只显示同组会话', async () => {
  const { parsed } = await call('ctm_list', {});
  const names = parsed.map((s) => s.名称).sort();
  assert.deepEqual(names, ['busy', 'lazy', 'sender-a']);
  const lazy = parsed.find((s) => s.名称 === 'lazy');
  assert.equal(lazy.状态, 'offline');
  assert.equal(lazy.组, 'frontend');
  assert.equal(lazy.未读, 2);
});

await check('ctm_list all=true 拒绝托管会话调用', async () => {
  const { isError, text } = await call('ctm_list', { all: true });
  assert.equal(isError, true);
  assert.match(text, /托管会话内不能使用 all=true/);
});

await check('ctm_list all=true 允许人调用', async () => {
  const { isError, parsed } = callAsHuman('ctm_list', { all: true });
  assert.equal(isError, false);
  const names = parsed.map((s) => s.名称).sort();
  assert.deepEqual(names, ['busy', 'lazy', 'orphan', 'outsider', 'sender-a']);
  const orphan = parsed.find((s) => s.名称 === 'orphan');
  assert.equal(orphan.组, '(独立)');
});

await check('ctm_status 拒绝跨组会话', async () => {
  const { isError, text } = await call('ctm_status', { name: 'outsider' });
  assert.equal(isError, true);
  assert.match(text, /不存在或不在当前可见组内/);
});

await check('ctm_tell 拒绝跨组投递', async () => {
  const before = readInbox('outsider').length;
  const { isError, text } = await call('ctm_tell', { to: 'outsider', text: '越界' });
  assert.equal(isError, true);
  assert.match(text, /不存在或不在当前可见组内/);
  assert.equal(readInbox('outsider').length, before);
});

await check('ctm_tell 拒绝发给无组会话', async () => {
  const { isError } = await call('ctm_tell', { to: 'orphan', text: '越界' });
  assert.equal(isError, true);
});

await check('ctm_start 拒绝跨组会话', async () => {
  const { isError } = await call('ctm_start', { name: 'outsider' });
  assert.equal(isError, true);
});

await check('ctm_tell 对同组离线目标会入队并尝试拉起', async () => {
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
  assert.deepEqual(argv, [
    'new',
    'lazy',
    '--cwd',
    WORK,
    '--settle',
    '2000',
    '--group',
    'frontend',
    '--',
    '--resume',
    'abc123',
  ]);
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
  assert.match(text, /不存在或不在当前可见组内/);
});

await check('ctm_ask 标记消息类型为 ask', async () => {
  const { parsed } = await call('ctm_ask', { to: 'busy', text: '在吗' });
  assert.equal(parsed.ok, true);
  const inbox = readInbox('busy');
  assert.equal(inbox[inbox.length - 1].kind, 'ask');
});

await check('ctm_reply 按短 id 回复来源会话', async () => {
  enqueue({ to: 'sender-a', from: 'busy', text: '帮我看看登录' });
  const mine = readInbox('sender-a');
  const msg = mine[mine.length - 1];
  const { isError, parsed } = await call('ctm_reply', {
    id: msg.id.slice(0, 8),
    text: '收到，马上看',
  });
  assert.equal(isError, false);
  assert.equal(parsed.to, 'busy');
  const inbox = readInbox('busy');
  assert.equal(inbox.at(-1).kind, 'reply');
  assert.equal(inbox.at(-1).from, 'sender-a');
});

await check('ctm_reply 不能回复用户消息', async () => {
  enqueue({ to: 'sender-a', from: '用户', text: '你自己看下' });
  const mine = readInbox('sender-a');
  const msg = mine[mine.length - 1];
  const { isError, text } = await call('ctm_reply', { id: msg.id, text: 'ok' });
  assert.equal(isError, true);
  assert.match(text, /来自用户本人/);
});

await check('ctm_reply 找不到消息时报错', async () => {
  const { isError, text } = await call('ctm_reply', { id: 'deadbeef', text: 'x' });
  assert.equal(isError, true);
  assert.match(text, /找不到消息/);
});

await check('ctm_room create 绑定当前会话的组', async () => {
  const { isError, parsed } = await call('ctm_room', {
    action: 'create',
    room: 'design',
    topic: '接口怎么改',
  });
  assert.equal(isError, false);
  assert.equal(parsed.group, 'frontend');
  assert.equal(parsed.createdBy, 'sender-a');
});

await check('ctm_room say 追加发言并保留来源', async () => {
  const { isError, parsed } = await call('ctm_room', {
    action: 'say',
    room: 'design',
    text: '先加版本号',
  });
  assert.equal(isError, false);
  assert.equal(parsed.from, 'sender-a');
  assert.equal(parsed.round, 0);
});

await check('ctm_room show 返回最近发言', async () => {
  const { parsed } = await call('ctm_room', { action: 'show', room: 'design' });
  assert.equal(parsed.name, 'design');
  assert.equal(parsed.messages.at(-1).text, '先加版本号');
});

await check('ctm_room start 只投递给同组成员', async () => {
  const { isError, parsed } = await call('ctm_room', {
    action: 'start',
    room: 'design',
    text: '第一轮：字段命名',
  });
  assert.equal(isError, false);
  assert.equal(parsed.round, 1);
  assert.ok(parsed.sent.includes('busy'));
  assert.ok(!parsed.sent.includes('outsider'));
  assert.ok(!parsed.sent.includes('orphan'));
  const inbox = readInbox('busy');
  assert.equal(inbox.at(-1).kind, 'room');
  assert.match(inbox.at(-1).text, /讨论 design · 第 1 轮/);
});

await check('ctm_room 拒绝其他组的频道', async () => {
  createRoom({ name: 'back-room', topic: '后端', group: 'backend' });
  const { isError, text } = await call('ctm_room', { action: 'show', room: 'back-room' });
  assert.equal(isError, true);
  assert.match(text, /不存在或不在当前可见组内/);
});

await check('ctm_room 拒绝创建其他组的频道', async () => {
  const { isError, text } = await call('ctm_room', {
    action: 'create',
    room: 'bad',
    topic: 'x',
    group: 'backend',
  });
  assert.equal(isError, true);
  assert.match(text, /不能创建其他组的频道/);
});

await check('ctm_room create 不能改写其他组已有频道', async () => {
  const before = readRoom('back-room');
  const { isError, text } = await call('ctm_room', {
    action: 'create',
    room: 'back-room',
    topic: '被篡改的议题',
  });
  assert.equal(isError, true);
  assert.match(text, /不存在或不在当前可见组内/);
  assert.equal(readRoom('back-room').topic, before.topic);
});

await check('ctm_room summary 生成文件', async () => {
  const { parsed } = await call('ctm_room', { action: 'summary', room: 'design' });
  assert.equal(parsed.ok, true);
  assert.ok(fs.existsSync(parsed.file));
});

await check('ctm_room start 无组频道只投无组会话', async () => {
  createRoom({ name: 'solo', topic: '独立讨论', group: '' });
  const { isError, parsed } = callAsHuman('ctm_room', {
    action: 'start',
    room: 'solo',
    text: '第一轮：独立议题',
  });
  assert.equal(isError, false);
  assert.ok(parsed.sent.includes('orphan'));
  assert.ok(!parsed.sent.includes('busy'));
  assert.ok(!parsed.sent.includes('outsider'));
  assert.ok(!parsed.sent.includes('lazy'));
  assert.ok(!parsed.sent.includes('sender-a'));
});

await check('ctm_room list 只显示同组频道', async () => {
  const { parsed } = await call('ctm_room', { action: 'list' });
  const names = parsed.map((r) => r.name);
  assert.ok(names.includes('design'));
  assert.ok(!names.includes('back-room'));
});

proc.stdin.end();
console.log(`\nRESULT=${fail === 0 ? 'MCP_OK' : 'MCP_FAIL'} pass=${pass} fail=${fail}`);
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
