#!/usr/bin/env node
// ctm CLI
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Session } from './session.mjs';
import { resolveClaudeBin, claudeVersion } from './resolve-claude.mjs';
import { ctmHome, listSessions, readMeta, isAlive, removeMeta, writeMeta } from './registry.mjs';
import { launchSession } from './launch.mjs';

function usage() {
  console.log(`ctm — Claude Terminal Multiplexer

用法：
  ctm new [name] [--cwd <path>] [--settle <ms>]   启动托管会话
  ctm start <name>                                重新拉起已存在但离线的会话
  ctm list                                        列出托管会话
  ctm kill <name>                                 结束会话
  ctm doctor                                      环境自检

环境变量：
  CTM_CLAUDE_BIN   指定 claude 可执行文件（绝对路径）
  CTM_HOME         ctm 数据目录，默认 ~/.ctm
  CTM_LAUNCH_MODE  按需启动方式：window（新终端窗口，默认）| background`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--settle') args.settle = Number(argv[++i]);
    else if (a === '--debug') args.debug = true;
    else args._.push(a);
  }
  return args;
}

function cmdNew(args) {
  const name = args._[1] || `c${Date.now().toString(36)}`;
  if (readMeta(name) && isAlive(readMeta(name).pid)) {
    console.error(`[ctm] 会话名已存在且仍在运行：${name}`);
    process.exit(1);
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  if (!fs.existsSync(cwd)) {
    console.error(`[ctm] 工作目录不存在：${cwd}`);
    process.exit(1);
  }

  let session;
  try {
    session = new Session({
      name,
      cwd,
      ctmDir: ctmHome(),
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      settleMs: args.settle ?? 3000,
      onStatus: args.debug ? (s) => process.stderr.write(`\r\n[ctm] ${name}: ${s}\r\n`) : undefined,
    });
  } catch (e) {
    console.error(`[ctm] 启动失败：${e.message}`);
    process.exit(1);
  }

  if (args.debug) {
    process.stderr.write(`[ctm] claude=${session.bin} (${session.binVia})\r\n`);
  }
  process.on('SIGINT', () => {
    session.stop();
    // 保留 meta：其他会话可以按需重新拉起本会话
    const meta = readMeta(name);
    if (meta) {
      writeMeta(name, {
        ...meta,
        pid: null,
        status: 'offline',
        exitedAt: new Date().toISOString(),
      });
    }
    setTimeout(() => process.exit(0), 300);
  });
}

function cmdStart(args) {
  const name = args._[1];
  if (!name) {
    console.error('用法：ctm start <name>');
    process.exit(1);
  }
  const meta = readMeta(name);
  if (!meta) {
    console.error(`[ctm] 找不到会话：${name}`);
    process.exit(1);
  }
  const r = launchSession(name);
  if (r.started) {
    console.log(`[ctm] 正在启动 ${name}（${r.mode}）`);
    return;
  }
  if (r.reason === 'already-running') {
    console.log(`[ctm] ${name} 已在运行`);
    return;
  }
  console.error(`[ctm] 启动失败：${r.reason}`);
  process.exit(1);
}

function cmdList() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log('（没有托管会话）');
    return;
  }
  const rows = sessions.map((m) => ({
    名称: m.name,
    状态: isAlive(m.pid) ? m.status || 'alive' : 'offline',
    PID: m.pid,
    目录: m.cwd,
    版本: m.version || '',
  }));
  console.table(rows);
}

function cmdKill(args) {
  const name = args._[1];
  if (!name) {
    console.error('用法：ctm kill <name>');
    process.exit(1);
  }
  const meta = readMeta(name);
  if (!meta) {
    console.error(`[ctm] 找不到会话：${name}`);
    process.exit(1);
  }
  if (!isAlive(meta.pid)) {
    removeMeta(name);
    console.log(`[ctm] ${name} 已不在运行，记录已清理`);
    return;
  }
  try {
    execFileSync('taskkill', ['/PID', String(meta.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try {
      process.kill(meta.pid);
    } catch {
      // 忽略
    }
  }
  removeMeta(name);
  console.log(`[ctm] 已结束 ${name}`);
}

async function cmdDoctor() {
  console.log('=== ctm doctor ===');
  console.log(`Node            ${process.version}`);
  console.log(`平台            ${process.platform} ${process.arch}`);
  console.log(`CTM_HOME        ${ctmHome()}`);

  let ok = true;

  try {
    const r = resolveClaudeBin();
    const ver = claudeVersion(r.bin);
    console.log(`claude 路径     ${r.bin}`);
    console.log(`解析方式        ${r.via}`);
    console.log(`claude 版本     ${ver || '(读取失败)'}${ver ? '' : '  ← 失败'}`);
    if (!ver) ok = false;

    if (r.candidates && r.candidates.length > 1) {
      console.log('\n检测到多个 claude 候选（已选 PATH 中最靠前的）：');
      for (const c of r.candidates) console.log(`  - ${c.path}`);
      console.log('  如需固定，请设置 CTM_CLAUDE_BIN');
    }
  } catch (e) {
    ok = false;
    console.log(`claude 解析     失败：${e.message}`);
  }

  // 与 shell 对照：托管进程必须和用户终端里执行的是同一个二进制
  try {
    const shellVer = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      shell: true,
      timeout: 30000,
    })
      .trim()
      .split('\n')[0];
    const r = resolveClaudeBin();
    const mine = claudeVersion(r.bin);
    console.log(`shell 中的版本  ${shellVer}`);
    console.log(`一致性          ${mine === shellVer ? '一致' : '不一致 ← 需要处理'}`);
    if (mine !== shellVer) ok = false;
  } catch (e) {
    console.log(`shell 对照      无法执行：${e.message.split('\n')[0]}`);
  }

  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 15000 });
    console.log(`Git             ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}`);
  } catch {
    ok = false;
    console.log('Git             未找到 ← 已有插件 hook 可能失败');
  }

  try {
    await import('node-pty');
    console.log('node-pty        可加载');
  } catch (e) {
    ok = false;
    console.log(`node-pty        不可加载：${e.message}`);
  }

  if (process.platform === 'win32') {
    const release = os.release();
    console.log(`Windows 内核    ${release}（ConPTY 需要 Win10 1809+，即 10.0.17763+）`);
  }

  console.log(`\n结论：${ok ? '通过' : '存在问题，见上'}`);
  process.exit(ok ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

switch (cmd) {
  case 'new':
    cmdNew(args);
    break;
  case 'start':
    cmdStart(args);
    break;
  case 'list':
    cmdList();
    break;
  case 'kill':
    cmdKill(args);
    break;
  case 'doctor':
    await cmdDoctor();
    break;
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    console.error(`未知命令：${cmd}`);
    usage();
    process.exit(1);
}
