// 单个托管会话：ConPTY 生命周期、IO 转发、状态机、消息注入。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn as ptySpawn } from 'node-pty';
import { ScreenBuffer, Bootstrap, isBusyText, normalize } from './tui.mjs';
import { resolveClaudeBin, claudeVersion } from './resolve-claude.mjs';
import { writeSettings } from './hooks.mjs';
import { writeMeta, readMeta, removeMeta, sessionDir } from './registry.mjs';
import { pendingMessages, markDelivered, readDelivered, formatMessage } from './inbox.mjs';
import { normalizeGroups } from './groups.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (const root of ['D:\\IDEAjava\\Git', 'C:\\Program Files\\Git']) {
    candidates.push(path.join(root, 'usr', 'bin'), path.join(root, 'bin'));
  }
  return candidates.filter((d) => {
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
    this.cwd = opts.cwd;
    this.ctmDir = opts.ctmDir;
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 40;
    this.settleMs = opts.settleMs ?? 3000;
    this.groups = normalizeGroups(opts.groups);
    this.claudeArgs = opts.claudeArgs || [];

    this.screen = new ScreenBuffer();
    this.bootstrap = new Bootstrap({ settleMs: this.settleMs });
    this.status = 'starting';
    this.exited = false;
    this.lastUserKeyAt = 0;
    this.eventOffset = 0;
    this.onStatus = opts.onStatus || (() => {});
    this.onExit =
      opts.onExit ||
      ((code) => {
        process.stderr.write(`\r\n[ctm] 会话 ${this.name} 已退出（code=${code}）\r\n`);
        process.exit(code || 0);
      });

    this.eventsFile = path.join(this.ctmDir, 'events', `${this.name}.jsonl`);
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
    if (gitDirs.length) env.PATH = gitDirs.join(';') + ';' + env.PATH;
    env.CTM_SESSION_NAME = this.name;

    this.proc = ptySpawn(
      this.bin,
      [...this.claudePrefix, '--settings', this.settingsFile, ...this.claudeArgs],
      {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
      },
    );

    this.proc.onData((d) => {
      process.stdout.write(d);
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
      // 供其他进程按需重新拉起本会话
      node: process.execPath,
      entry: path.resolve(process.argv[1] || ''),
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
        this.bootstrap.startedAt = Date.now();
        this.setStatus('starting');
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
    } else if (action === 'settled') {
      this.setStatus('idle');
    } else if (action === 'timeout') {
      this.setStatus('unknown');
    }
  }

  pollEvents() {
    let text;
    try {
      const stat = fs.statSync(this.eventsFile);
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
    // 先置 busy，避免 Stop 到达前被重复投递
    this.setStatus('busy');

    try {
      this.proc.write(text);
      await sleep(delayMs);
      this.proc.write('\r');
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: e.message };
    }

    // 提交确认：esc to interrupt 或 clear 后出现新的模型输出。
    // 只看写入之后新产生的文本，避免历史内容误判。
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = normalize(this.screen.raw.slice(before));
      if (isBusyText(fresh)) return { ok: true };
      await sleep(150);
    }

    // 没等到信号：可能模型很快答完，或消息停在输入框。
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
