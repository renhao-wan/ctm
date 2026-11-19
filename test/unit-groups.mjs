// 分组可见性与 claude 包装判定的单元测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  normalizeGroups,
  groupsOf,
  visibleTo,
  describeGroups,
  resolveGroups,
  cleanSessionName,
  sessionNameFor,
  shouldPassthrough,
} = await import('../src/groups.mjs');

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

const A = { name: 'a', groups: ['frontend'] };
const B = { name: 'b', groups: ['frontend', 'shared'] };
const C = { name: 'c', groups: ['frontend'] };
const D = { name: 'd', groups: ['backend'] };
const E = { name: 'e', groups: ['backend'] };
const F = { name: 'f', groups: [] };
const G = { name: 'g', groups: [] };
const guest = { name: '', groups: [] };

check('组名去重并支持逗号分隔', () => {
  assert.deepEqual(normalizeGroups(['frontend,shared', 'frontend', ' backend ']), [
    'frontend',
    'shared',
    'backend',
  ]);
});

check('groupsOf 容忍缺失字段', () => {
  assert.equal(groupsOf({}).size, 0);
  assert.equal(groupsOf(null).size, 0);
  assert.deepEqual([...groupsOf({ groups: ['x'] })], ['x']);
});

check('同组互相可见', () => {
  assert.equal(visibleTo(A, C), true);
  assert.equal(visibleTo(A, B), true);
});

check('不同组不可见', () => {
  assert.equal(visibleTo(A, D), false);
  assert.equal(visibleTo(D, A), false);
});

check('多组会话通过交集桥接', () => {
  assert.equal(visibleTo(B, A), true);
  assert.equal(visibleTo(B, D), false);
});

check('无组会话只看得见自己', () => {
  assert.equal(visibleTo(F, F), true);
  assert.equal(visibleTo(F, G), false);
  assert.equal(visibleTo(G, F), false);
});

check('无组与有组互不可见', () => {
  assert.equal(visibleTo(F, A), false);
  assert.equal(visibleTo(A, F), false);
});

check('没有身份的调用者看到全部', () => {
  assert.equal(visibleTo(guest, A), true);
  assert.equal(visibleTo(guest, F), true);
});

check('组描述用于列表展示', () => {
  assert.equal(describeGroups(A), 'frontend');
  assert.equal(describeGroups(B), 'frontend,shared');
  assert.equal(describeGroups(F), '(独立)');
});

check('组来源优先级：命令行 > 环境变量 > 项目文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-groups-'));
  fs.writeFileSync(path.join(dir, '.ctm.json'), JSON.stringify({ groups: ['from-file'] }));

  assert.deepEqual(resolveGroups({ cliGroups: ['cli'], cwd: dir, env: { CTM_GROUP: 'env' } }), ['cli']);
  assert.deepEqual(resolveGroups({ cwd: dir, env: { CTM_GROUP: 'env' } }), ['env']);
  assert.deepEqual(resolveGroups({ cwd: dir, env: {} }), ['from-file']);
  assert.deepEqual(resolveGroups({ cwd: dir, env: { CTM_GROUP: ' , ' } }), ['from-file']);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-groups-empty-'));
  assert.deepEqual(resolveGroups({ cwd: empty, env: {} }), []);
});

check('会话名取目录名并清理非法字符', () => {
  assert.equal(sessionNameFor('D:/projects/web'), 'web');
  assert.equal(sessionNameFor('D:/projects/my app (v2)'), 'my-app-v2');
  assert.equal(sessionNameFor('D:/projects/中文目录'), '中文目录');
  assert.equal(sessionNameFor('D:/'), 'session');
});

check('任意名字都能清洗成合法会话名', () => {
  assert.equal(cleanSessionName('resume-../x'), 'resume-..-x');
  assert.equal(cleanSessionName('..'), 'session');
  assert.equal(cleanSessionName('...x'), 'x');
  assert.equal(cleanSessionName('a'.repeat(100)).length, 64);
  assert.match(cleanSessionName('a/b\\c:d'), /^[^/\\:]+$/);
});

check('交互式启动不 passthrough', () => {
  assert.equal(shouldPassthrough([]), false);
  assert.equal(shouldPassthrough(['--resume']), false);
  assert.equal(shouldPassthrough(['--continue']), false);
  assert.equal(shouldPassthrough(['--dangerously-skip-permissions']), false);
});

check('非交互用法原样透传', () => {
  assert.equal(shouldPassthrough(['--version']), true);
  assert.equal(shouldPassthrough(['-p', '写个函数']), true);
  assert.equal(shouldPassthrough(['mcp', 'list']), true);
  assert.equal(shouldPassthrough(['config']), true);
  assert.equal(shouldPassthrough(['--settings', 'x.json']), true);
});

console.log(`\nRESULT=${fail === 0 ? 'GROUPS_OK' : 'GROUPS_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
