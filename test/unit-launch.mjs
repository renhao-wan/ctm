// 按需启动单元测试：只验证决策与参数，不加载 node-pty，也不需要 claude。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-launch-'));
process.env.CTM_HOME = CTM_HOME;
process.env.CTM_LAUNCH_MODE = 'background';

const { writeMeta, readMeta, sessionDir } = await import('../src/registry.mjs');
const { launchSession } = await import('../src/launch.mjs');
const { enqueue, pendingMessages } = await import('../src/inbox.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-launch-cwd-'));

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

const base = {
  cwd: WORK,
  settleMs: 1234,
  node: process.execPath,
  entry: path.join(WORK, 'fake-entry.mjs'),
};

await check('离线会话可以入队，消息留在收件箱', () => {
  writeMeta('offline', { name: 'offline', pid: null, cwd: WORK, status: 'offline' });
  const msg = enqueue({ to: 'offline', from: 'a', text: '稍后处理' });
  assert.ok(pendingMessages('offline').some((m) => m.id === msg.id));
});

await check('未知会话返回 unknown-session', () => {
  const r = launchSession('nobody', { mode: 'background' });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'unknown-session');
});

await check('已运行的会话不会被重复启动', () => {
  writeMeta('alive', { name: 'alive', pid: process.pid, cwd: WORK, ...base });
  const r = launchSession('alive', { mode: 'background' });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'already-running');
});

await check('工作目录不存在时拒绝启动', () => {
  writeMeta('badcwd', {
    name: 'badcwd',
    pid: null,
    ...base,
    cwd: path.join(WORK, 'missing'),
  });
  const r = launchSession('badcwd', { mode: 'background' });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'cwd-not-found');
});

await check('入口文件不存在时拒绝启动', () => {
  writeMeta('badentry', { name: 'badentry', pid: null, ...base, entry: path.join(WORK, 'nope.mjs') });
  const r = launchSession('badentry', { mode: 'background' });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'entry-not-found');
});

await check('配置检查失败不会占住启动锁', () => {
  assert.ok(!fs.existsSync(path.join(sessionDir('badentry'), 'launch.lock')));
});

await check('新写入的启动锁会阻止并发重复启动', () => {
  fs.writeFileSync(path.join(WORK, 'fake-entry.mjs'), 'process.exit(0)\n');
  writeMeta('locked', { name: 'locked', pid: null, status: 'offline', ...base });
  fs.mkdirSync(sessionDir('locked'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir('locked'), 'launch.lock'), String(Date.now()));
  const r = launchSession('locked', { mode: 'background' });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'launching');
});

await check('过期的启动锁会被忽略', () => {
  writeMeta('stale', { name: 'stale', pid: null, ...base });
  fs.writeFileSync(path.join(WORK, 'fake-entry.mjs'), 'process.exit(0)\n');
  const lock = path.join(sessionDir('stale'), 'launch.lock');
  fs.mkdirSync(sessionDir('stale'), { recursive: true });
  fs.writeFileSync(lock, '0');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const r = launchSession('stale', { mode: 'background' });
  assert.equal(r.started, true);
});

await check('后台启动会把会话参数原样传给宿主入口', async () => {
  const record = path.join(WORK, 'argv.json');
  fs.writeFileSync(
    path.join(WORK, 'record-entry.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  writeMeta('spawned', {
    name: 'spawned',
    pid: null,
    status: 'offline',
    groups: ['frontend', 'shared'],
    claudeArgs: ['--resume', 'abc123'],
    ...base,
    entry: path.join(WORK, 'record-entry.mjs'),
  });
  const r = launchSession('spawned', { mode: 'background' });
  assert.equal(r.started, true);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(record)) await sleep(100);
  assert.ok(fs.existsSync(record), '宿主入口未被执行');
  const argv = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(argv, [
    'new',
    'spawned',
    '--cwd',
    WORK,
    '--settle',
    '1234',
    '--group',
    'frontend',
    '--group',
    'shared',
    '--',
    '--resume',
    'abc123',
  ]);
});

await check('无组会话拉起时显式保留无组', async () => {
  const record = path.join(WORK, 'argv-nogroup.json');
  fs.writeFileSync(
    path.join(WORK, 'record-entry-nogroup.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  writeMeta('nogroup', {
    name: 'nogroup',
    pid: null,
    status: 'offline',
    groups: [],
    ...base,
    entry: path.join(WORK, 'record-entry-nogroup.mjs'),
  });
  const r = launchSession('nogroup', { mode: 'background' });
  assert.equal(r.started, true);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(record)) await sleep(100);
  assert.ok(fs.existsSync(record), '宿主入口未被执行');
  const argv = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(argv, ['new', 'nogroup', '--cwd', WORK, '--settle', '1234', '--no-group']);
});

await check('启动后 meta 仍保留离线状态，等宿主接手', () => {
  const meta = readMeta('spawned');
  assert.equal(meta.pid, null);
  assert.equal(meta.status, 'offline');
});

console.log(`\nRESULT=${fail === 0 ? 'LAUNCH_OK' : 'LAUNCH_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
