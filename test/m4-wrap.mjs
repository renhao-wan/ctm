// M4：claude 包装入口的端到端测试。
//
// 验证：在带 .ctm.json 的项目里执行 `ctm wrap`，会启动一个托管会话，
// 会话名取目录名，组来自项目配置，meta.json 里能看到 pid 与组。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const CTM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-m4-'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-m4-proj-'));
const WORK = path.join(ROOT, 'my app');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, '.ctm.json'), JSON.stringify({ group: 'frontend' }));

process.env.CTM_HOME = CTM_HOME;
const { readMeta } = await import('../src/registry.mjs');

const ENTRY = path.resolve('src/main.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [ENTRY, 'wrap'], {
  cwd: WORK,
  env: { ...process.env, CTM_HOME },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d;
});

// wrap 不指定名字：目录名 "my app" 应被清理成 my-app
const NAME = 'my-app';
let meta = null;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  meta = readMeta(NAME);
  if (meta && meta.pid) break;
  if (child.exitCode !== null) break;
  await sleep(250);
}

const checks = [
  ['托管会话已创建（名字来自目录）', !!meta],
  ['目录名中的空格被清理为 -', !!meta && meta.name === NAME],
  ['组来自项目 .ctm.json', !!meta && JSON.stringify(meta.groups) === JSON.stringify(['frontend'])],
  ['meta 记录了 claude 进程 pid', !!meta && Number.isInteger(meta.pid)],
  ['工作目录正确', !!meta && path.resolve(meta.cwd) === path.resolve(WORK)],
];

console.log('--- checks ---');
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
if (stderr.trim()) console.log(`\nstderr:\n${stderr.trim().split('\n').slice(-8).join('\n')}`);

const allOk = checks.every(([, ok]) => ok);
console.log(`\nRESULT=${allOk ? 'M4_WRAP_OK' : 'M4_WRAP_FAIL'}`);

try {
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
} catch {
  // 已退出
}
setTimeout(() => process.exit(allOk ? 0 : 1), 500);
