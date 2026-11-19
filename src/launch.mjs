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

// cmd.exe / CRT 的参数规则：引号内的 "" 表示一个字面引号
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * 按原会话配置构造 `ctm new` 参数。
 * groups 决定归属，claudeArgs 里可能有 --resume，二者丢了都会让拉起后的
 * 会话变成另一个东西，必须从 meta 一起恢复。
 */
function buildArgs({ name, entry, cwd, settleMs, groups, claudeArgs = [] }) {
  const settleNum = Number(settleMs);
  const settle = Number.isFinite(settleNum) && settleNum >= 0 ? String(Math.floor(settleNum)) : '3000';
  const args = [entry, 'new', name, '--cwd', cwd, '--settle', settle];
  if (Array.isArray(groups)) {
    // groups 缺失表示旧版 meta，交给 ctm new 按默认来源解析；
    // 空数组则是明确的「无组」，用 --no-group 阻止 .ctm.json 重新归组。
    if (groups.length === 0) args.push('--no-group');
    else {
      for (const g of groups) {
        if (typeof g === 'string' && g) args.push('--group', g);
      }
    }
  }
  if (claudeArgs.length) args.push('--', ...claudeArgs.map(String));
  return args;
}

/** 拉起的 claude 不应继承当前进程的托管身份。 */
function launchEnv() {
  const env = { ...process.env };
  delete env.CTM_SESSION_NAME;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  // 组由 meta 里的 --group 恢复；继承父进程的 CTM_GROUP 会让无组会话被误归组
  delete env.CTM_GROUP;
  return env;
}

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
  // 新终端窗口是 Windows 专用：其它平台没有 wt.exe/cmd start，
  // 继续走 window 分支会静默失败但返回 started=true。
  if (mode === 'window' && process.platform !== 'win32') mode = 'background';

  const meta = readMeta(name);
  if (!meta) return { started: false, reason: 'unknown-session' };
  if (isAlive(meta.pid)) return { started: false, reason: 'already-running' };

  const node = meta.node || process.execPath;
  const entry = meta.entry || DEFAULT_ENTRY;
  const cwd = meta.cwd;
  // 先做本地检查再上锁：配置缺失不该占住 15 秒的重试窗口
  if (!cwd || !fs.existsSync(cwd)) return { started: false, reason: 'cwd-not-found' };
  if (!fs.existsSync(entry)) return { started: false, reason: 'entry-not-found' };
  if (!fs.existsSync(node)) return { started: false, reason: 'node-not-found' };

  const lock = launchLock(name);
  if (!lock.ok) return { started: false, reason: 'launching' };

  const args = buildArgs({
    name,
    entry,
    cwd,
    settleMs: meta.settleMs,
    groups: meta.groups,
    claudeArgs: Array.isArray(meta.claudeArgs) ? meta.claudeArgs : [],
  });
  const env = launchEnv();

  if (mode === 'background') {
    const log = fs.openSync(path.join(sessionDir(name), 'host.log'), 'a');
    const child = spawn(node, args, {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      env,
    });
    // 子进程已复制句柄，父进程侧要及时释放
    try {
      fs.closeSync(log);
    } catch {
      // 忽略
    }
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

  const cmdline = args.map(quote).join(' ');

  // Windows Terminal 优先；不存在时回退到 cmd start
  const wt = spawn('wt.exe', ['-d', cwd, 'cmd', '/k', cmdline], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  wt.on('error', () => {
    const fallback = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', cmdline], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    });
    fallback.on('error', () => {});
    fallback.unref();
  });
  wt.unref();

  return { started: true, mode: 'window' };
}
