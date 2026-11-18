// 收件箱单元测试（不启动 PTY）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-inbox-'));
process.env.CTM_HOME = CTM_HOME;

const {
  enqueue,
  readInbox,
  readDelivered,
  markDelivered,
  pendingMessages,
  formatMessage,
  UnknownSessionError,
} = await import('../src/inbox.mjs');
const { writeMeta, sessionDir } = await import('../src/registry.mjs');

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

// 用当前进程 PID 扮演一个存活的托管会话
writeMeta('b', { name: 'b', pid: process.pid, cwd: 'D:/projects/api', status: 'idle' });

check('向不存在的会话投递会报错', () => {
  assert.throws(() => enqueue({ to: 'nobody', from: 'a', text: 'hi' }), UnknownSessionError);
});

check('空消息被拒绝', () => {
  assert.throws(() => enqueue({ to: 'b', from: 'a', text: '   ' }), /消息内容为空/);
});

check('投递后能从收件箱读出完整字段', () => {
  const msg = enqueue({ to: 'b', from: 'a', fromCwd: 'D:/projects/web', text: '端口是多少？', kind: 'ask' });
  const list = readInbox('b');
  const got = list.find((m) => m.id === msg.id);
  assert.ok(got, '未找到消息');
  assert.equal(got.from, 'a');
  assert.equal(got.fromCwd, 'D:/projects/web');
  assert.equal(got.to, 'b');
  assert.equal(got.kind, 'ask');
  assert.equal(got.text, '端口是多少？');
  assert.equal(typeof got.createdAt, 'string');
});

check('未投递消息按写入顺序返回', () => {
  const before = pendingMessages('b').length;
  enqueue({ to: 'b', from: 'a', text: 'first' });
  enqueue({ to: 'b', from: 'a', text: 'second' });
  const pending = pendingMessages('b');
  assert.equal(pending.length, before + 2);
  assert.equal(pending[pending.length - 2].text, 'first');
  assert.equal(pending[pending.length - 1].text, 'second');
});

check('标记已投递后不再返回', () => {
  const msg = enqueue({ to: 'b', from: 'a', text: 'once' });
  assert.ok(pendingMessages('b').some((m) => m.id === msg.id));
  markDelivered('b', msg.id);
  assert.ok(!pendingMessages('b').some((m) => m.id === msg.id));
  assert.ok(readDelivered('b').has(msg.id));
});

check('写到一半的行不会导致解析失败', () => {
  fs.appendFileSync(path.join(sessionDir('b'), 'inbox.jsonl'), '{"id":"broken"\n');
  const list = readInbox('b');
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 0);
});

check('注入文本带长前缀', () => {
  const t = formatMessage({ from: 'web', fromCwd: 'D:/projects/web', text: '你好' });
  assert.ok(t.includes('来自会话 web'));
  assert.ok(t.includes('D:/projects/web'));
  assert.ok(t.endsWith('你好'));
});

check('无会话身份时标记为用户而不是会话', () => {
  const t = formatMessage({ from: '用户', fromCwd: 'D:/projects/api', text: '看下日志' });
  assert.ok(t.startsWith('[来自用户，工作区 D:/projects/api]'));
});

check('消息前缀带可回复的短 id', () => {
  const t = formatMessage({
    id: '7f3a1c2d-0000-4000-8000-000000000000',
    from: 'web',
    fromCwd: 'D:/projects/web',
    text: '你好',
  });
  assert.ok(t.includes('#7f3a1c2d'));
});

console.log(`\nRESULT=${fail === 0 ? 'INBOX_OK' : 'INBOX_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
