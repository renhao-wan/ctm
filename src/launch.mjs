// 按需启动一个已配置过的会话。
//
// 使用场景：A 发消息给 B，但 B 的窗口没开。
// meta.json 保留了 B 的 cwd、node 和入口路径，因此可以由任意进程重新拉起它。
// 默认在新终端窗口里启动；测试可用 CTM_LAUNCH_MODE=background 改为后台运行。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMeta, isAlive, sessionDir } from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.join(HERE, 'main.mjs');

const quote = (s) => `"${s}"`;

function launchLock(name) {
  const lock = path.join(sessionDir(name), 'launch.lock');
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 15000) return { ok: false, lock };
  } catch {
    // 不存在
  }
  fs.mkdirSync(sessionDir(name), { recursive: true });
  fs.writeFileSync(lock, String(Date.now()));
  return { ok: true, lock };
}

/**
 * 重新拉起会话。
 * @returns {{started:boolean, reason?:string, mode?:string}}
 */
export function launchSession(name, { mode = process.env.CTM_LAUNCH_MODE || 'window' } = {}) {
  const meta = readMeta(name);
  if (!meta) return { started: false, reason: 'unknown-session' };
  if (isAlive(meta.pid)) return { started: false, reason: 'already-running' };

  const node = meta.node || process.execPath;
  const entry = meta.entry || DEFAULT_ENTRY;
  const settle = String(meta.settleMs ?? 3000);
  const cwd = meta.cwd;
  // 先做本地检查再上锁：配置缺失不该占住 15 秒的重试窗口
  if (!cwd || !fs.existsSync(cwd)) return { started: false, reason: 'cwd-not-found' };
  if (!fs.existsSync(entry)) return { started: false, reason: 'entry-not-found' };
  if (!fs.existsSync(node)) return { started: false, reason: 'node-not-found' };

  const lock = launchLock(name);
  if (!lock.ok) return { started: false, reason: 'launching' };

  const args = [entry, 'new', name, '--cwd', cwd, '--settle', settle];

  if (mode === 'background') {
    const log = fs.openSync(path.join(sessionDir(name), 'host.log'), 'a');
    const child = spawn(node, args, {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      env: process.env,
    });
    // 监听但不抛出：spawn 失败只体现在 host.log 与后续状态里
    child.on('error', (e) => {
      try {
        fs.appendFileSync(path.join(sessionDir(name), 'host.log'), `\n[ctm] spawn failed: ${e.message}\n`);
      } catch {
        // 忽略
      }
    });
    child.unref();
    return { started: true, mode: 'background', pid: child.pid };
  }

  const cmdline = [quote(node), quote(entry), 'new', quote(name), '--cwd', quote(cwd), '--settle', settle].join(' ');

  // Windows Terminal 优先；不存在时回退到 cmd start
  const wt = spawn('wt.exe', ['-d', cwd, 'cmd', '/k', cmdline], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: process.env,
  });
  wt.on('error', () => {
    const fallback = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', cmdline], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: process.env,
    });
    fallback.on('error', () => {});
    fallback.unref();
  });
  wt.unref();

  return { started: true, mode: 'window' };
}
