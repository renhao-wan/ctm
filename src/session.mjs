// 单个托管会话：ConPTY 生命周期、IO 转发、状态机、消息注入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { spawn as ptySpawn } from 'node-pty';
import { ScreenBuffer, Bootstrap, isBusyText, isPermissionPrompt, normalize } from './tui.mjs';
import { resolveClaudeBin, claudeVersion } from './resolve-claude.mjs';
import { writeSettings } from './hooks.mjs';
import { writeMeta, readMeta, sessionDir, isValidSessionName } from './registry.mjs';
import { pendingMessages, markDelivered, readDelivered, formatMessage } from './inbox.mjs';
import { normalizeGroups } from './groups.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ctm 自己作为 Claude Code 插件所在的目录。
// 托管会话必须加载它，否则会话里的 AI 拿不到 ctm_* 工具，
// 指南里“在会话内用 /ctm:ask”就不成立。
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 传给 claude 的插件目录参数。
 * 用户已经显式指定 --plugin-dir 时不重复添加；CTM_NO_PLUGIN=1 可关闭，
 * 便于排查“是插件导致启动异常”这类问题。
 */
function pluginArgs(claudeArgs, { disabled = process.env.CTM_NO_PLUGIN === '1' } = {}) {
  if (disabled) return [];
  if (claudeArgs.some((a) => a === '--plugin-dir' || String(a).startsWith('--plugin-dir='))) {
    return [];
  }
  try {
    return fs.existsSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
      ? ['--plugin-dir', PLUGIN_ROOT]
      : [];
  } catch {
    return [];
  }
}

/** 探测 Git Bash 目录。已有插件 hook 的 run-hook.cmd 要求 PATH 里有 bash。 */
export function detectGitDirs() {
  const candidates = [];
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    // .../<gitRoot>/mingw64/libexec/git-core
    const root = path.resolve(execPath, '..', '..', '..');
    candidates.push(path.join(root, 'usr', 'bin'), path.join(root, 'bin'));
  } catch {
    // git 不在 PATH，走常见位置
  }
  for (const root of [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
  ]) {
    if (!root) continue;
    candidates.push(path.join(root, 'usr', 'bin'), path.join(root, 'bin'));
  }
  return [...new Set(candidates)].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

export class Session {
  /**
   * @param {{ name: string, cwd: string, ctmDir: string, cols?: number, rows?: number,
   *           settleMs?: number, groups?: string[], claudeArgs?: string[],
   *           onStatus?: (s: string) => void }} opts
   */
  constructor(opts) {
    this.name = opts.name;
    // 会话名会拼进 events/settings 路径，构造前先挡住 ../ 之类
    if (!isValidSessionName(this.name)) {
      throw new Error(`会话名不合法：${this.name}`);
    }
    this.cwd = opts.cwd;
    this.ctmDir = opts.ctmDir;
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 40;
    const settle = Number(opts.settleMs);
    this.settleMs = Number.isFinite(settle) && settle >= 0 ? settle : 3000;
    this.quiet = opts.quiet === true;
    this.groups = normalizeGroups(opts.groups);
    this.claudeArgs = opts.claudeArgs || [];

    this.screen = new ScreenBuffer();
    this.bootstrap = new Bootstrap({ settleMs: this.settleMs });
    this.status = 'starting';
    this.exited = false;
    this.lastUserKeyAt = 0;
    this.permissionAckAt = 0;
    this.eventOffset = 0;
    this.lastHook = '';
    this.lastHookAt = 0;
    this.onStatus = opts.onStatus || (() => {});
    this.onExit =
      opts.onExit ||
      ((code) => {
        process.stderr.write(`\r\n[ctm] 会话 ${this.name} 已退出（code=${code}）\r\n`);
        process.exit(code || 0);
      });

    this.eventsFile = path.join(this.ctmDir, 'events', `${this.name}.jsonl`);
    // 复用离线会话名时 events 文件里可能还有上一轮的事件。
    // 从文件末尾开始读，避免陈旧 hook 被当作本次注入的确认信号。
    try {
      this.eventOffset = fs.statSync(this.eventsFile).size;
    } catch {
      this.eventOffset = 0;
    }
    this.settingsFile = writeSettings({
      dir: path.join(this.ctmDir, 'sessions', this.name),
      name: this.name,
      eventsFile: this.eventsFile,
    });

    const resolved = resolveClaudeBin();
    this.bin = resolved.bin;
    this.claudePrefix = resolved.prefix || [];
    this.binVia = resolved.via;

    const env = { ...process.env };
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const gitDirs = detectGitDirs();
    if (gitDirs.length) {
      // Windows 上环境变量名通常是 Path，展开成普通对象后大小写敏感
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[pathKey] = gitDirs.join(path.delimiter) + path.delimiter + (env[pathKey] || '');
    }
    env.CTM_SESSION_NAME = this.name;

    this.proc = ptySpawn(
      this.bin,
      [
        ...this.claudePrefix,
        '--settings',
        this.settingsFile,
        ...pluginArgs(this.claudeArgs),
        ...this.claudeArgs,
      ],
      {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
      },
    );

    this.proc.onData((d) => {
      if (!this.quiet) process.stdout.write(d);
      this.screen.append(d);
    });
    this.proc.onExit(({ exitCode }) => {
      // 进程已自行退出，不要再 kill：node-pty 会尝试 AttachConsole 并报错
      this.exited = true;
      this.clearTimers();
      // 保留 meta：其他进程要靠它按需重新拉起本会话
      const meta = readMeta(this.name);
      if (meta) {
        writeMeta(this.name, {
          ...meta,
          pid: null,
          status: 'offline',
          exitedAt: new Date().toISOString(),
          exitCode,
        });
      }
      this.onExit(exitCode);
    });

    writeMeta(this.name, {
      name: this.name,
      pid: this.proc.pid,
      cwd: this.cwd,
      bin: this.bin,
      binVia: this.binVia,
      version: claudeVersion(this.bin, this.claudePrefix) || '',
      status: 'starting',
      groups: this.groups,
      settleMs: this.settleMs,
      // 按需拉起要恢复启动参数，否则 --resume 之类的会话会变成空对话
      claudeArgs: this.claudeArgs,
      // 供其他进程按需重新拉起本会话
      node: process.execPath,
      entry: process.argv[1] ? path.resolve(process.argv[1]) : '',
      startedAt: new Date().toISOString(),
    });

    // meta 里已经有新 pid 了，其他进程不会再重复拉起；此时才放开启动锁
    try {
      fs.rmSync(path.join(sessionDir(this.name), 'launch.lock'), { force: true });
    } catch {
      // 忽略
    }

    this.bindStdin();
    this.delivered = readDelivered(this.name);
    this.inboxBusy = false;
    this.timers = [
      setInterval(() => this.tick(), 250),
      setInterval(() => this.pollEvents(), 500),
      setInterval(() => this.pumpInbox(), 500),
      setInterval(() => this.syncMeta(), 5000),
    ];
  }

  bindStdin() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      this.lastUserKeyAt = Date.now();
      // 用户在需要确认的提示上按了键：交回启动状态机重新判定
      if (this.status === 'needs-input') {
        if (this.bootstrap.phase !== 'done') {
          this.bootstrap.startedAt = Date.now();
          this.setStatus('starting');
        } else {
          // 运行期权限提示：用户已作出选择，claude 会继续执行。
          // 先恢复 busy，避免下一 tick 把同一提示再次标记为 needs-input。
          this.permissionAckAt = Date.now();
          this.setStatus('busy');
        }
      }
      try {
        this.proc.write(d.toString('utf8'));
      } catch {
        // PTY 已关闭
      }
    });
    process.stdout.on('resize', () => {
      try {
        this.proc.resize(process.stdout.columns, process.stdout.rows);
      } catch {
        // 已退出
      }
    });
  }

  tick() {
    const t = this.screen.text();
    const action = this.bootstrap.step(t);

    if (action === 'enter') {
      this.proc.write('\r');
    } else if (action === 'trust-down') {
      // 默认选中 "No, exit"：先下移到 "Yes, I trust this folder"，
      // 由下一次 tick 确认屏幕已选中 Yes 后再回车
      this.proc.write('\x1b[B');
    } else if (action === 'not-now') {
      this.proc.write('2');
      setTimeout(() => {
        try {
          this.proc.write('\r');
        } catch {
          // 已退出
        }
      }, 400);
    } else if (action === 'ready') {
      this.setStatus('ready');
    } else if (action === 'needs-input') {
      this.setStatus('needs-input');
    } else if (action === 'trust-unknown') {
      // 信任提示的布局不认识（版本差异或渲染未完成）。宿主不能代按，
      // 也不能一直停在 starting：交给用户在窗口里处理，并暂停投递。
      this.setStatus('needs-input');
    } else if (action === 'settled') {
      this.setStatus('idle');
    } else if (action === 'timeout') {
      this.setStatus('unknown');
    }

    // 启动流程结束后才检测运行期权限提示；启动阶段的 MCP 确认由 Bootstrap 处理。
    // 会话卡在权限确认上不会发 Stop，必须主动识别，否则会一直显示忙。
    if (
      this.bootstrap.phase === 'done' &&
      this.status !== 'needs-input' &&
      Date.now() - this.permissionAckAt > 3000 &&
      isPermissionPrompt(t)
    ) {
      this.setStatus('needs-input');
    }
  }

  pollEvents() {
    let text;
    try {
      const stat = fs.statSync(this.eventsFile);
      // 文件被清空或轮转：旧偏移已失效，从头读
      if (stat.size < this.eventOffset) this.eventOffset = 0;
      if (stat.size <= this.eventOffset) return;
      const fd = fs.openSync(this.eventsFile, 'r');
      const buf = Buffer.alloc(stat.size - this.eventOffset);
      fs.readSync(fd, buf, 0, buf.length, this.eventOffset);
      fs.closeSync(fd);
      this.eventOffset = stat.size;
      text = buf.toString('utf8');
    } catch {
      return;
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.hook === 'Stop') this.setStatus('idle');
      else if (ev.hook === 'UserPromptSubmit' || ev.hook === 'PreToolUse' || ev.hook === 'PostToolUse')
        this.setStatus('busy');
      else if (ev.hook === 'SessionEnd') this.setStatus('offline');
      this.lastHook = ev.hook;
      this.lastHookAt = Date.now();
    }
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
    this.syncMeta();
  }

  /** 把实时状态写回 meta.json，供 ctm list 与插件读取。 */
  syncMeta() {
    if (this.exited) return;
    const meta = readMeta(this.name);
    if (!meta) return;
    writeMeta(this.name, {
      ...meta,
      status: this.status,
      lastSeen: new Date().toISOString(),
    });
  }

  get ready() {
    return this.status === 'idle' || this.status === 'busy';
  }

  /**
   * 向会话注入一条消息，表现为用户输入。
   * 返回 { ok, reason }。M1 不做排队，调用方自行决定是否重试。
   */
  async inject(text, { delayMs = 200, timeoutMs = 8000 } = {}) {
    if (!this.ready) return { ok: false, reason: 'not-ready' };
    if (this.status !== 'idle') return { ok: false, reason: 'busy' };
    if (Date.now() - this.lastUserKeyAt < 2000) return { ok: false, reason: 'user-typing' };

    const before = this.screen.raw.length;
    const hookMark = this.lastHookAt;
    // 先置 busy，避免 Stop 到达前被重复投递
    this.setStatus('busy');

    // 提交确认有三条互相独立的证据：
    //   1. 屏幕出现 "esc to interrupt"（思考/长任务阶段不一定出现）
    //   2. 收到 UserPromptSubmit/PreToolUse/PostToolUse（说明输入已被接受）
    //   3. 收到 Stop（说明这一轮已经跑完）
    // 只认屏幕会让刚提交但还没渲染状态的会话被误判为失败。
    const isConfirmed = () =>
      isBusyText(normalize(this.screen.raw.slice(before))) ||
      (this.lastHookAt > hookMark &&
        ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(this.lastHook));

    try {
      this.proc.write(text);
      await sleep(delayMs);
      this.proc.write('\r');
    } catch (e) {
      // 已置 busy，写失败时不能把状态留在原地，否则投递永久停止
      this.setStatus('idle');
      return { ok: false, reason: 'write-failed', error: e.message };
    }

    let deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isConfirmed()) return { ok: true };
      await sleep(150);
    }

    // 没等到信号：新会话首条消息可能被 TUI 吞掉回车，输入框里还留着文本。
    // 补发一次回车（已提交时是空回车，无害），再给约 4 秒。
    try {
      this.proc.write('\r');
    } catch {
      // PTY 已关闭
    }
    deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (isConfirmed()) return { ok: true };
      await sleep(150);
    }

    // 仍然没有信号：可能消息停在输入框，也可能模型已答完但钩子没来。
    // 不能把会话卡在 busy —— 没有 Stop 会来，后续投递会永久阻塞。
    this.setStatus('idle');
    return { ok: false, reason: 'unconfirmed' };
  }

  /**
   * 投递收件箱中的下一条消息。
   * 只在 idle、用户最近 2 秒没有按键时进行；一次只投一条，
   * 下一条要等本轮 Stop 回来、状态重新变为 idle。
   */
  async pumpInbox() {
    if (this.inboxBusy || this.exited || this.status !== 'idle') return;
    if (Date.now() - this.lastUserKeyAt < 2000) return;

    const pending = pendingMessages(this.name, this.delivered);
    if (pending.length === 0) return;

    const msg = pending[0];
    this.inboxBusy = true;
    try {
      const r = await this.inject(formatMessage(msg));
      if (r.ok) {
        markDelivered(this.name, msg.id);
        this.delivered.add(msg.id);
      }
    } catch {
      // 写失败：保持未投递，下一轮 tick 重试
    } finally {
      this.inboxBusy = false;
    }
  }

  stop() {
    this.clearTimers();
    if (this.exited) return;
    try {
      this.proc.kill();
    } catch {
      // 已退出
    }
  }

  clearTimers() {
    for (const t of this.timers || []) clearInterval(t);
    this.timers = [];
  }
}
