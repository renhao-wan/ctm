// 讨论频道单元测试：存储、可见性、轮次投递与摘要。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-rooms-'));
process.env.CTM_HOME = CTM_HOME;

const { writeMeta } = await import('../src/registry.mjs');
const { readInbox } = await import('../src/inbox.mjs');
const {
  normalizeRoomName,
  readRoom,
  createRoom,
  roomVisible,
  listRooms,
  appendSay,
  readMessages,
  startRound,
  writeSummary,
} = await import('../src/rooms.mjs');

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

check('频道名清洗为安全文件名', () => {
  assert.equal(normalizeRoomName('api design'), 'api-design');
  assert.equal(normalizeRoomName(' API/设计 '), 'API-设计');
  assert.equal(normalizeRoomName('../etc'), 'etc');
  assert.throws(() => normalizeRoomName('   '), /不能为空/);
  assert.throws(() => normalizeRoomName('x'.repeat(65)), /过长/);
  // Windows 保留名无法作为目录名，必须提前挡住
  assert.throws(() => normalizeRoomName('CON'), /保留名/);
  assert.throws(() => normalizeRoomName('lpt1'), /保留名/);
  assert.equal(normalizeRoomName('console'), 'console');
});

check('创建频道写入 meta', () => {
  const r = createRoom({ name: 'api', topic: '认证接口怎么改', group: 'backend', createdBy: 'a' });
  assert.equal(r.name, 'api');
  assert.equal(r.group, 'backend');
  assert.equal(r.round, 0);
  assert.equal(readRoom('api').topic, '认证接口怎么改');
});

check('重复创建只更新议题，不清空轮次', () => {
  createRoom({ name: 'api', topic: '第一版' });
  appendSay({ room: 'api', from: 'a', text: 'x' });
  const r = createRoom({ name: 'api', topic: '第二版' });
  assert.equal(r.topic, '第二版');
  assert.equal(readMessages('api').length, 1);
});

check('频道可见性按组隔离', () => {
  const room = readRoom('api'); // backend
  assert.equal(roomVisible({ name: 'a', groups: ['backend'] }, room), true);
  assert.equal(roomVisible({ name: 'x', groups: ['frontend'] }, room), false);
  assert.equal(roomVisible({ name: '', groups: [] }, room), true); // 人
  const solo = createRoom({ name: 'solo', topic: '独立' });
  assert.equal(roomVisible({ name: 'y', groups: [] }, solo), true);
  assert.equal(roomVisible({ name: 'z', groups: ['frontend'] }, solo), false);
});

check('listRooms 只返回本组频道', () => {
  createRoom({ name: 'fe', topic: '前端', group: 'frontend' });
  const back = listRooms({ name: 'a', groups: ['backend'] }).map((r) => r.name);
  assert.ok(back.includes('api'));
  assert.ok(!back.includes('fe'));
  const all = listRooms({ name: '', groups: [] }).map((r) => r.name);
  assert.ok(all.includes('api') && all.includes('fe'));
});

check('发言按轮次追加', () => {
  const m = appendSay({ room: 'api', from: 'b', text: '建议先加版本号' });
  assert.equal(m.round, 0);
  const list = readMessages('api');
  assert.equal(list[list.length - 1].text, '建议先加版本号');
  assert.equal(list[list.length - 1].from, 'b');
});

check('startRound 递增轮次并把议题投递给成员', () => {
  writeMeta('m1', { name: 'm1', pid: null, cwd: 'D:/a', groups: ['backend'] });
  writeMeta('m2', { name: 'm2', pid: null, cwd: 'D:/b', groups: ['backend'] });
  const r = startRound({ room: 'api', issue: '第一轮：接口字段', from: 'a', targets: ['m1', 'm2'] });
  assert.equal(r.round, 1);
  assert.deepEqual(r.sent.sort(), ['m1', 'm2']);
  assert.equal(readRoom('api').round, 1);
  const inbox = readInbox('m1');
  assert.equal(inbox[inbox.length - 1].kind, 'room');
  assert.match(inbox[inbox.length - 1].text, /讨论 api · 第 1 轮/);
  assert.match(inbox[inbox.length - 1].text, /第一轮：接口字段/);
});

check('第二轮沿用频道议题', () => {
  const r = startRound({ room: 'api', from: 'a', targets: [] });
  assert.equal(r.round, 2);
  assert.deepEqual(r.sent, []);
});

check('summary 汇总各轮发言', () => {
  const file = writeSummary('api');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# 第一版|# 第二版/);
  assert.match(text, /## 第 1 轮/);
  assert.match(text, /建议先加版本号/);
});

check('不存在的频道报错', () => {
  assert.throws(() => appendSay({ room: 'nope', text: 'x' }), /频道不存在/);
  assert.throws(() => startRound({ room: 'nope', targets: [] }), /频道不存在/);
});

console.log(`\nRESULT=${fail === 0 ? 'ROOMS_OK' : 'ROOMS_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
