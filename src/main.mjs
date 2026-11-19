#!/usr/bin/env node
// ctm CLI
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Session, detectGitDirs } from './session.mjs';
import { resolveClaudeBin, claudeVersion } from './resolve-claude.mjs';
import {
  ctmHome,
  listSessions,
  readMeta,
  isAlive,
  isValidSessionName,
  removeMeta,
  writeMeta,
} from './registry.mjs';
import { launchSession } from './launch.mjs';
import { pendingMessages, readDelivered } from './inbox.mjs';
import {
  appendSay,
  createRoom,
  listRooms,
  inRoomAudience,
  readMessages,
  readRoom,
  roomVisible,
  startRound,
  writeSummary,
} from './rooms.mjs';
import {
  cleanSessionName,
  describeGroups,
  resolveGroups,
  sessionNameFor,
  shouldPassthrough,
} from './groups.mjs';

function usage() {
  console.log(`ctm — Claude Terminal Multiplexer

用法：
  ctm new [name] [--cwd <path>] [--group <g>] [--settle <ms>] [-- <claude 参数>]
                                                  启动托管会话
  ctm resume [sessionId] [--group <g>] [--settle <ms>] [-- <claude 参数>]
                                                  在新托管会话中恢复对话
  ctm start <name>                                重新拉起已存在但离线的会话
  ctm list                                        列出托管会话
  ctm kill <name>                                 结束会话
  ctm room <list|create|say|show|start|summary> <频道> [内容]
                                                  组内讨论频道
  ctm doctor                                      环境自检
  ctm wrap [claude 参数]                          包装入口（给 claude 命令用）
  ctm install-wrap                                生成 claude 包装脚本

环境变量：
  CTM_CLAUDE_BIN   指定 claude 可执行文件（绝对路径）
  CTM_HOME         ctm 数据目录，默认 ~/.ctm
  CTM_LAUNCH_MODE  按需启动方式：window（新终端窗口，默认）| background
  CTM_GROUP        包装启动时的默认组（逗号分隔）`);
}

function parseArgs(argv) {
  const args = { _: [] };
  const valueOf = (i, flag) => {
    if (argv[i] === undefined || argv[i] === '') {
      console.error(`[ctm] ${flag} 需要一个值`);
      process.exit(1);
    }
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') args.cwd = valueOf(++i, '--cwd');
    else if (a === '--settle') {
      const raw = valueOf(++i, '--settle');
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`[ctm] --settle 需要一个非负毫秒数：${raw}`);
        process.exit(1);
      }
      args.settle = n;
    } else if (a === '--group') {
      const g = valueOf(++i, '--group');
      (args.groups ||= []).push(g);
    } else if (a.startsWith('--group=')) {
      const g = a.slice('--group='.length);
      if (!g) {
        console.error('[ctm] --group 需要一个值');
        process.exit(1);
      }
      (args.groups ||= []).push(g);
    } else if (a === '--no-group') args.noGroup = true;
    else if (a === '--debug') args.debug = true;
    else if (a === '--') {
      // -- 之后原样交给 claude：ctm new web -- --resume <id>
      args.claudeArgs = argv.slice(i + 1);
      break;
    } else args._.push(a);
  }
  return args;
}

function startHost({ name, cwd, groups = [], settleMs = 3000, claudeArgs = [], debug = false }) {
  let session;
  try {
    session = new Session({
      name,
      cwd,
      ctmDir: ctmHome(),
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      settleMs,
      groups,
      claudeArgs,
      onStatus: debug ? (s) => process.stderr.write(`\r\n[ctm] ${name}: ${s}\r\n`) : undefined,
    });
  } catch (e) {
    console.error(`[ctm] 启动失败：${e.message}`);
    process.exit(1);
  }

  if (debug) {
    process.stderr.write(`[ctm] claude=${session.bin} (${session.binVia})\r\n`);
    process.stderr.write(`[ctm] 组=${describeGroups({ groups })}\r\n`);
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

function cmdNew(args) {
  const name = args._[1] || `c${Date.now().toString(36)}`;
  if (!isValidSessionName(name)) {
    console.error(
      `[ctm] 会话名不合法：${name}\n` +
        '  只能包含字母、数字、中文、点、下划线和短横线，长度 1-64，不能以点结尾。',
    );
    process.exit(1);
  }
  const existing = readMeta(name);
  if (existing && isAlive(existing.pid)) {
    console.error(`[ctm] 会话名已存在且仍在运行：${name}`);
    process.exit(1);
  }
  const cwd = path.resolve(args.cwd || process.cwd());
  if (!fs.existsSync(cwd)) {
    console.error(`[ctm] 工作目录不存在：${cwd}`);
    process.exit(1);
  }
  // --no-group 是拉起时用来精确恢复「无组」的内部参数：
  // 否则项目里的 .ctm.json 会在重新拉起时给会话加上组。
  const groups = args.noGroup ? [] : resolveGroups({ cliGroups: args.groups, cwd });
  startHost({
    name,
    cwd,
    groups,
    settleMs: args.settle ?? 3000,
    claudeArgs: args.claudeArgs || [],
    debug: args.debug,
  });
}

/** 在新的托管会话里恢复历史对话。不是接管原进程。 */
function cmdResume(args) {
  const sessionId = args._[1];
  const cwd = path.resolve(process.cwd());
  const base = cleanSessionName(
    sessionId ? `resume-${sessionId.slice(0, 8)}` : `resume-${Date.now().toString(36)}`,
  );
  const name = uniqueName(base);
  const groups = resolveGroups({ cliGroups: args.groups, cwd });
  const claudeArgs = [
    ...(sessionId ? ['--resume', sessionId] : ['--resume']),
    ...(args.claudeArgs || []),
  ];
  startHost({
    name,
    cwd,
    groups,
    settleMs: args.settle ?? 3000,
    claudeArgs,
    debug: args.debug,
  });
}

/** 同名会话还活着就加后缀；已离线则复用名字（连同收件箱）。 */
function uniqueName(base) {
  const free = (n) => {
    const m = readMeta(n);
    return !m || !isAlive(m.pid);
  };
  if (free(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base}-${i}`;
    if (free(n)) return n;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function execClaude(argv) {
  const r = resolveClaudeBin();
  const env = { ...process.env };
  // 透传出去的是一个新的 claude 进程，不应继承父会话的身份
  delete env.CTM_SESSION_NAME;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  const child = spawn(r.bin, [...(r.prefix || []), ...argv], { stdio: 'inherit', env });
  child.on('error', (e) => {
    console.error(`[ctm] 无法启动 claude：${e.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/**
 * claude 命令的包装入口。
 * 交互式启动 → 变成托管会话，名字取当前目录名；
 * --version / -p / mcp 等非交互用法 → 原样交给真正的 claude。
 */
function cmdWrap() {
  const raw = process.argv.slice(3);
  const claudeArgs = [];
  const cliGroups = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--group') {
      if (raw[i + 1] === undefined) {
        console.error('[ctm] --group 需要一个值');
        process.exit(1);
      }
      cliGroups.push(raw[++i]);
    } else if (a.startsWith('--group=')) {
      const g = a.slice('--group='.length);
      if (!g) {
        console.error('[ctm] --group 需要一个值');
        process.exit(1);
      }
      cliGroups.push(g);
    } else if (a === '--') {
      // -- 之后全部是 claude 自己的参数（可能包含 --group）
      claudeArgs.push(a, ...raw.slice(i + 1));
      break;
    } else {
      claudeArgs.push(a);
    }
  }

  if (shouldPassthrough(claudeArgs)) return execClaude(claudeArgs);

  const cwd = process.cwd();
  const name = uniqueName(sessionNameFor(cwd));
  const groups = resolveGroups({ cliGroups, cwd });
  startHost({ name, cwd, groups, settleMs: 3000, claudeArgs });
}

function cmdInstallWrap() {
  const dir = path.join(ctmHome(), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.resolve(process.argv[1]);
  const node = process.execPath;

  if (process.platform === 'win32') {
    const file = path.join(dir, 'claude.cmd');
    fs.writeFileSync(file, `@echo off\r\nrem ctm-wrap\r\n"${node}" "${entry}" wrap %*\r\n`);
    console.log(`[ctm] 已生成 ${file}`);
    console.log('\n把该目录放到 PATH 的最前面：');
    console.log(`  set PATH=${dir};%PATH%`);
  } else {
    const file = path.join(dir, 'claude');
    fs.writeFileSync(
      file,
      `#!/bin/sh\n# ctm-wrap\nexec "${node}" "${entry}" wrap "$@"\n`,
      { mode: 0o755 },
    );
    console.log(`[ctm] 已生成 ${file}`);
    console.log(`  export PATH="${dir}:$PATH"`);
  }

  console.log('\n之后敲 claude 的交互式启动会自动变成托管会话；');
  console.log('--version、-p、mcp 等非交互用法会原样透传。');
  console.log('默认组取自 --group、CTM_GROUP 或项目里的 .ctm.json。');
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
  const rows = sessions.map((m) => {
    const alive = isAlive(m.pid);
    const status = alive ? m.status || 'alive' : 'offline';
    const row = {
      名称: m.name,
      状态: status === 'needs-input' ? 'needs-input ⚠' : status,
      组: describeGroups(m),
      未读: pendingMessages(m.name, readDelivered(m.name)).length,
      PID: m.pid,
      目录: m.cwd,
      版本: m.version || '',
    };
    if (status === 'needs-input') row.提示 = '等待用户在该窗口确认';
    return row;
  });
  console.table(rows);
}

function cmdRoom(args) {
  // CLI 操作者是人，没有会话身份，不受组可见性限制
  const me = { name: '', groups: [] };
  const action = args._[1] || 'list';
  const name = args._[2];
  const rest = args._.slice(3).join(' ');

  if (action === 'list') {
    const rooms = listRooms(me);
    if (rooms.length === 0) {
      console.log('（没有讨论频道）');
      return;
    }
    console.table(
      rooms.map((r) => ({
        频道: r.name,
        组: r.group || '(独立)',
        轮次: r.round || 0,
        消息数: readMessages(r.name, 0).length,
        议题: r.topic || '',
        更新: r.updatedAt || '',
      })),
    );
    return;
  }

  if (!name) {
    console.error('用法：ctm room <list|create|say|show|start|summary> <频道> [内容]');
    process.exit(1);
  }

  if (action === 'create') {
    const group = (args.groups || [])[0] || '';
    console.log(
      JSON.stringify(createRoom({ name, topic: rest, group, createdBy: '用户' }), null, 2),
    );
    return;
  }

  const room = readRoom(name);
  if (!room || !roomVisible(me, room)) {
    console.error(`[ctm] 频道不存在：${name}`);
    process.exit(1);
  }

  if (action === 'say') {
    if (!rest) {
      console.error('用法：ctm room say <频道> <内容>');
      process.exit(1);
    }
    console.log(
      JSON.stringify(appendSay({ room: room.name, from: '用户', text: rest }), null, 2),
    );
    return;
  }

  if (action === 'show') {
    console.log(JSON.stringify({ ...room, messages: readMessages(room.name, 50) }, null, 2));
    return;
  }

  if (action === 'start') {
    const targets = listSessions()
      .filter((m) => inRoomAudience(m, room))
      .map((m) => m.name);
    console.log(
      JSON.stringify(
        startRound({ room: room.name, issue: rest, from: '用户', targets }),
        null,
        2,
      ),
    );
    return;
  }

  if (action === 'summary') {
    console.log(writeSummary(room.name));
    return;
  }

  console.error(`未知动作：${action}`);
  process.exit(1);
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
  let killed = false;
  try {
    execFileSync('taskkill', ['/PID', String(meta.pid), '/T', '/F'], { stdio: 'ignore' });
    killed = true;
  } catch {
    try {
      process.kill(meta.pid);
      killed = true;
    } catch {
      // 交给下面的存活检查判断
    }
  }
  // 杀不掉时保留 meta：否则记录消失但进程还在，之后既管不了也会被重复拉起
  if (!killed && isAlive(meta.pid)) {
    console.error(`[ctm] 无法结束 ${name}（PID ${meta.pid}），记录已保留`);
    process.exit(1);
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

  // 数据目录必须可写：注册表、收件箱、讨论频道都落在这里
  try {
    fs.mkdirSync(ctmHome(), { recursive: true });
    const probe = path.join(ctmHome(), `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    console.log('数据目录        可写');
  } catch (e) {
    ok = false;
    console.log(`数据目录        不可写：${e.message} ← 需要处理`);
  }

  // 包装脚本是可选能力，缺失不算失败
  const wrapDir = path.join(ctmHome(), 'bin');
  const wrapFile = path.join(wrapDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (fs.existsSync(wrapFile)) {
    const inPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .some((p) => {
        try {
          return path.resolve(p).toLowerCase() === path.resolve(wrapDir).toLowerCase();
        } catch {
          return false;
        }
      });
    console.log(
      `claude 包装     ${wrapFile}${inPath ? '（已在 PATH）' : '（未在 PATH，敲 claude 仍是普通会话）'}`,
    );
  } else {
    console.log('claude 包装     未安装（ctm install-wrap 可生成）');
  }

  if (process.platform === 'win32') {
    let hasWt = false;
    try {
      execFileSync('where', ['wt.exe'], { stdio: 'ignore' });
      hasWt = true;
    } catch {
      // 没有 Windows Terminal 不是错误
    }
    console.log(`wt.exe          ${hasWt ? '可用（按需启动开新窗口）' : '未找到（回退 cmd.exe /c start）'}`);
  }

  try {
    const r = resolveClaudeBin();
    const ver = claudeVersion(r.bin, r.prefix);
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
    const mine = claudeVersion(r.bin, r.prefix);
    console.log(`shell 中的版本  ${shellVer}`);
    console.log(`一致性          ${mine === shellVer ? '一致' : '不一致 ← 需要处理'}`);
    if (mine !== shellVer) ok = false;
  } catch (e) {
    console.log(`shell 对照      无法执行：${e.message.split('\n')[0]}`);
  }

  try {
    const gitVer = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    console.log(`Git             ${gitVer}`);
    // 已有插件 hook 的 run-hook.cmd 需要 bash；找不到时给出修复提示
    const gitBins = detectGitDirs();
    if (gitBins.length) {
      console.log(`Git Bash 路径   ${gitBins.join(';')}`);
    } else {
      ok = false;
      console.log('Git Bash 路径   未找到 usr/bin ← 插件 hook 可能失败，请安装 Git for Windows');
    }
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

// 统一兜底：CLI 层面的可预期错误（频道名过长、锁文件损坏等）
// 只打印一行提示，不把内部栈丢给用户。
try {
  switch (cmd) {
    case 'new':
      cmdNew(args);
      break;
    case 'wrap':
      cmdWrap();
      break;
    case 'install-wrap':
      cmdInstallWrap();
      break;
    case 'start':
      cmdStart(args);
      break;
    case 'resume':
      cmdResume(args);
      break;
    case 'list':
      cmdList();
      break;
    case 'room':
      cmdRoom(args);
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
} catch (e) {
  console.error(`[ctm] ${e.message}`);
  process.exit(1);
}
