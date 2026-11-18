// claude 可执行文件解析的单元测试。
// 覆盖三类真实安装形态：直接 exe、npm .cmd shim、只有 node + cli.js 的 shim，
// 以及 ctm 自己生成的包装脚本（必须跳过，否则会无限递归）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveClaudeBin } = await import('../src/resolve-claude.mjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-resolve-'));
const DIR_A = path.join(ROOT, 'a');
const DIR_B = path.join(ROOT, 'b');
const DIR_C = path.join(ROOT, 'c');
for (const d of [DIR_A, DIR_B, DIR_C]) fs.mkdirSync(d, { recursive: true });

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

const envWith = (...dirs) => ({ PATH: dirs.join(path.delimiter) });

check('直接命中 claude.exe', () => {
  const exe = path.join(DIR_A, 'claude.exe');
  fs.writeFileSync(exe, '');
  const r = resolveClaudeBin(envWith(DIR_A));
  assert.equal(r.bin, exe);
  assert.deepEqual(r.prefix, []);
});

check('npm .cmd shim 解析到真实 exe', () => {
  const pkg = path.join(DIR_B, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  const exe = path.join(pkg, 'claude.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(
    path.join(DIR_B, 'claude.cmd'),
    '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
  );
  const r = resolveClaudeBin(envWith(DIR_B));
  assert.equal(r.bin, exe);
  assert.deepEqual(r.prefix, []);
});

check('只有 node + cli.js 时返回 prefix', () => {
  fs.writeFileSync(path.join(DIR_C, 'node.exe'), '');
  fs.writeFileSync(path.join(DIR_C, 'cli.js'), '');
  fs.writeFileSync(
    path.join(DIR_C, 'claude.cmd'),
    '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\cli.js" %*\r\n',
  );
  const r = resolveClaudeBin(envWith(DIR_C));
  assert.equal(path.basename(r.bin), 'node.exe');
  assert.deepEqual(r.prefix, [path.join(DIR_C, 'cli.js')]);
});

check('ctm 生成的包装脚本不会被当成 claude', () => {
  const wrapDir = path.join(ROOT, 'wrap');
  fs.mkdirSync(wrapDir, { recursive: true });
  fs.writeFileSync(
    path.join(wrapDir, 'claude.cmd'),
    '@echo off\r\nrem ctm-wrap\r\n"node.exe" "D:/x/ctm/src/main.mjs" wrap %*\r\n',
  );
  const r = resolveClaudeBin(envWith(wrapDir, DIR_A));
  assert.equal(r.bin, path.join(DIR_A, 'claude.exe'));
  assert.equal(r.bin.includes('node.exe'), false);
});

check('CTM_CLAUDE_BIN 优先级最高', () => {
  const custom = path.join(ROOT, 'custom.exe');
  fs.writeFileSync(custom, '');
  const r = resolveClaudeBin({ PATH: DIR_A, CTM_CLAUDE_BIN: custom });
  assert.equal(r.bin, custom);
  assert.equal(r.via, 'CTM_CLAUDE_BIN');
});

check('CTM_CLAUDE_BIN 指向不存在的文件会报错', () => {
  assert.throws(() => resolveClaudeBin({ PATH: DIR_A, CTM_CLAUDE_BIN: path.join(ROOT, 'no.exe') }), /不存在/);
});

check('完全解析不到时报错而不是回退裸名', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-resolve-empty-'));
  assert.throws(() => resolveClaudeBin(envWith(empty)), /未能在 PATH 中解析/);
});

check('多个候选按 PATH 顺序取第一个', () => {
  const r = resolveClaudeBin(envWith(DIR_A, DIR_B));
  assert.equal(r.bin, path.join(DIR_A, 'claude.exe'));
  assert.ok(r.candidates.length >= 2);
});

console.log(`\nRESULT=${fail === 0 ? 'RESOLVE_OK' : 'RESOLVE_FAIL'} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
